var series = require('async').series;
var parallel = require('async').parallel;
var fs = require('fs');
var nodePath = require('path');
var parser = require('./util/less-parser');
var defaultUrlResolver = require('./util/url-resolver');
var ok = require('assert').ok;
var DataHolder = require('raptor-async/DataHolder');

function Loader() {
    this.cache = {};
}

Loader.prototype = {
    loadLessFile: function(path, callback) {
        var dataHolder = this.cache[path];
        var _this = this;

        if (!dataHolder) {
            dataHolder = this.cache[path] = new DataHolder();
            fs.readFile(path, 'utf8', function(err, lessCode) {
                var parsedLess = parser.parse(lessCode, path);
                if (err) {
                    dataHolder.reject(err);
                    return;
                }

                // Start pre-loading the imported Less files:
                var parts = parsedLess.getParts();
                for (var i=0, len=parts.length; i<len; i++) {
                    var part = parts[i];
                    if (part.isImport()) {
                        var importPath = part.getImportPath();
                        _this.loadLessFile(importPath);
                    }
                }

                dataHolder.resolve(parsedLess);
            });
        }

        if (callback) {
            dataHolder.done(callback);
        }
    }
};

exports.load = function(lessDependencies, lessContext, pluginConfig, callback) {
    var urlResolver = pluginConfig.urlResolver || defaultUrlResolver;
    ok(urlResolver, '"urlResolver" expected');

    var optimizerContext = lessContext.optimizerContext;
    ok(optimizerContext, '"optimizerContext" expected');

    var optimizer = optimizerContext.optimizer;
    ok(optimizer, '"optimizer" expected');

    var loader = new Loader();

    var output = [];

    var foundImports = {};

    function processLessFile(parsedLess, depth, callback) {

        var parts = parsedLess.getParts();
        var dirname = parsedLess.getDirname();
        var relativePath = nodePath.relative(process.cwd(), parsedLess.getPath());

        // console.log('PROCESSING BEGIN: ', relativePath);

        var importTasks = [];
        var urlTasks = [];

        parts.forEach(function(part) {
            if (part.isImport()) {
                var importPath = part.getImportPath();

                importTasks.push(function(callback) {
                    if (foundImports[importPath]) {
                        // Remove the import since it was already handled
                        part.replaceWith('/* @import "' + part.text + '"; (skipped, already imported) */');
                        callback();
                    } else {
                        foundImports[importPath] = true;

                        // console.log('PROCESSING @import "' + importPath + '" in "' + relativePath);
                        loader.loadLessFile(importPath, function(err, parsedLess) {
                            if (err) {
                                return callback(err);
                            }

                            processLessFile(parsedLess, depth+1, function(err, importedLessCode) {
                                if (err) {
                                    return callback(err);
                                }

                                part.replaceWith('/* @import "' + part.text + '"; */\n' + importedLessCode);
                                callback();
                            });
                        });
                    }
                });
            } else if (part.isUrl()) {
                var url = part.getUrl();
                urlTasks.push(function(callback) {
                    urlResolver(url, dirname, optimizerContext, function(err, url) {
                        if (err) {
                            return callback(err);
                        }

                        if (!url) {
                            return callback();
                        }

                        optimizer.optimizeResource(url, {optimizerContext: optimizerContext}, function(err, optimizedResource) {
                            if (err) {
                                return callback(err);
                            }

                            if (optimizedResource && optimizedResource.url) {
                                part.replaceWith(optimizedResource.url);
                            }

                            callback();
                        });
                    });
                });
            }
        });

        parallel([
                function handleImports(callback) {
                    // Process the imports in series since we must de-dupe
                    // imports if an import was included earlier
                    series(importTasks, callback);
                },
                function handleUrls(callback) {
                    // Process the URLs in parallel since order doesn't matter
                    parallel(urlTasks, callback);
                }
            ],
            function(err) {
                if (err) {
                    return callback(err);
                }

                var depthString = '';
                for (var i=0; i<depth; i++) {
                    depthString += '+';
                }

                if (depthString.length) {
                    depthString += ' ';
                }

                var lessCode = parsedLess.getLessCode();
                var prefix = '/* ' + depthString + 'BEGIN "' + relativePath + '" */\n';
                var suffix = '\n/* ' + depthString + 'END "' + relativePath + '" */\n';
                callback(null, prefix + lessCode + suffix);
                // console.log('PROCESSING END: ', relativePath);
            });

    }

    var work = lessDependencies.map(function(lessDependency) {
        return function(callback) {
            var path = lessDependency.path;

            if (foundImports[path]) {
                callback();
            } else {
                foundImports[path] = true;

                loader.loadLessFile(path, function(err, parsedLess) {
                    if (err) {
                        return callback(err);
                    }

                    processLessFile(parsedLess, 0, function(err, lessCode) {
                        if (err) {
                            return callback(err);
                        }

                        output.push(lessCode);
                        callback();
                    });
                });
            }
        };
    });

    series(work, function(err) {
        if (err) {
            return callback(err);
        }

        var lessCode = output.join('\n');
        lessCode += '\n.x {}'; // HACK: Less is removing trailing comments and this hack
                               // fixes that. .x {} doesn't get rendered since it is empty
        // console.log('LESS OUTPUT: ', lessCode);
        callback(null, lessCode);
    });
};