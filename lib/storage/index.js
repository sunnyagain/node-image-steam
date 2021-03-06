var path = require('path');
var _ = require('lodash');
var EventEmitter = require('events').EventEmitter;
var Image = require('../image');
var StorageBase = require('./storage-base');

module.exports = Storage;

function Storage(options) {
  if (!(this instanceof Storage)) {
    return new Storage(options);
  }

  EventEmitter.call(this);

  this.options = options || {};

  this.artifactReplicas = [];
  this.optimizedReplicas = [];
  if (this.options.replicas) {
    Object.keys(this.options.replicas).forEach(key => {
      const replica = this.options.replicas[key];
      if (!replica) return;
      if (replica.replicateArtifacts !== false && replica.cache) {
        this.artifactReplicas.push(replica.cache);
      }
      const cache = replica.cacheOptimized || replica.cache;
      if (cache) {
        this.optimizedReplicas.push(cache);
      }
    });
  }

  // drivers will be initialized on-demand due to the light weight nature of design
  this.drivers = {};
}

Storage.Base = StorageBase;

var p = Storage.prototype = new EventEmitter();

p.getDriver = function(options) {
  var driver = this.drivers['byPath/' + options.driverPath] // use driverPath if applicable
    || this.drivers['byName/' + options.driver] // use driver name if applicable
  ;

  function createDriver(opts) {
    var driver;

    if (opts.driverPath) {
      driver = new (require(opts.driverPath))(opts);
      driver.name = 'byPath/' + opts.driverPath;
    } else if (opts.driver) {
      driver = new (require('./' + opts.driver))(opts);
      driver.name = 'byName/' + opts.driver;
    } else {
      throw new Error('No driver provided');
    }

    return driver;
  }

  if (!driver) {
    // if not found, create it
    driver = createDriver(options);

    // store by name
    this.drivers[driver.name] = driver;
  }

  return driver;
};

p.fetch = function(req, { originalPath, hashFromOptimizedOriginal }, { hash }, cb) {
  var $this = this;
  var driverInfo;
  try {
    driverInfo = this.getDriverInfo(originalPath, req, { hash, hashFromOptimizedOriginal });
  } catch (ex) {
    this.emit('warn', ex);
    return void cb(ex);
  }

  driverInfo.driver.fetch(driverInfo.options, driverInfo.realPath, hash, function(err, img, imgData) {
    if (err) {
      $this.emit('warn', err);
      return void cb(err);
    }

    // backward compatible
    if (!(img instanceof Image)) {
      img = new Image(img, imgData);
    }

    cb(null, img);
  });
};

p.store = function(req, { originalPath, hashFromOptimizedOriginal }, { hash, touch, replica, options }, image, cb) {
  var driverInfo;
  try {
    driverInfo = this.getDriverInfo(originalPath, req, { hash, hashFromOptimizedOriginal, options });
  } catch (ex) {
    this.emit('warn', ex);
    return cb && cb(ex);
  }
  image.info.lastModified = new Date(); // auto-tracking of lastModified in meta unless storage client overrides

  driverInfo.driver[touch ? 'touch' : 'store'](driverInfo.options, driverInfo.realPath, hash, image, err => {
    if (err) {
      this.emit('warn', err);
      return cb && cb(err);
    }

    cb && cb();
  });

  if (!touch && !replica) { // do not process replication for touches and recursion
    if (hash !== hashFromOptimizedOriginal) {
      this.artifactReplicas.forEach(
        replica => this.store(req, { originalPath, hashFromOptimizedOriginal }, { hash, replica: true, options: replica }, image)
      );
    }
    else {
      this.optimizedReplicas.forEach(
        replica => this.store(req, { originalPath, hashFromOptimizedOriginal }, { hash, replica: true, options: replica }, image)
      );
    }
  }
};

p.deleteCache = function(req, { originalPath, useOptimized }, cb) {
  var $this = this;
  var driverInfo;
  try {
    driverInfo = this.getDriverInfo(originalPath, req, {
      hash: 'cache',
      hashFromOptimizedOriginal: useOptimized ? 'cache' : null
    });
  } catch (ex) {
    this.emit('warn', ex);
    return void cb(ex);
  }
  if (!driverInfo.driver.deleteCache) {
    const err = new Error(`deleteCache not supported on storage driver ${driverInfo.driver.name}`);
    this.emit('warn', err);
    return void cb(err);
  }
  driverInfo.driver.deleteCache(driverInfo.options, driverInfo.realPath, function(err) {
    if (err) {
      $this.emit('warn', err);
      return void cb(err);
    }

    if (!useOptimized && $this.options.cacheOptimized) {
      // if optimized originals have their own cache, delete there as well
      return void $this.deleteCache(req, { originalPath, useOptimized: true }, cb);
    }

    cb();
  });
};

p.getDriverInfo = function(originalPath, req, { hash, hashFromOptimizedOriginal, options }) {
  var defaults = this.options.defaults || {};
  var opts = defaults;
  var realPath = originalPath;

  var firstPart = this.options.app && originalPath.split('/')[0];

  if (options) { // use explicit options if provided
    opts = _.merge({}, defaults, options);
  } else if (!!hash && this.options.cacheOptimized && hash === hashFromOptimizedOriginal) { // use cacheOptimized if enabled
    opts = _.merge({}, defaults, this.options.cacheOptimized);
  } else if (!!hash && this.options.cache) { // use cache if enabled
    opts = _.merge({}, defaults, this.options.cache);
  } else if (this.options.app && firstPart in this.options.app) {
    // if app match, use custom options
    opts = _.merge({}, defaults, this.options.app[firstPart]);
    realPath = originalPath.substr(firstPart.length + 1);
  } else if (this.options.domain && req.headers.host in opts.domain) {
    // if domain match, use custom options
    opts = _.merge({}, defaults, this.options.domain[req.headers.host]);
  } else if (this.options.header && req.headers['x-isteam-app'] in opts.header) {
    // if `x-isteam-app` header match, use custom options
    opts = _.merge({}, defaults, opts.header[req.headers['x-isteam-app']]);
  }

  return {
    driver: this.getDriver(opts),
    options: opts,
    realPath: realPath
  };
};
