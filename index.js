var async = require('async');
var _ = require('lodash');
var cuid = require('cuid');
var expressBearerToken = require('express-bearer-token');
var cors = require('cors');

module.exports = {

  moogBundle: {
    directory: 'lib/modules',
    modules: [ 'apostrophe-pieces-headless' ]
  },

  afterConstruct: function(self, callback) {
    self.addRoutes();
    if (self.options.bearerTokens) {
      self.apos.on('csrfExceptions', self.addCsrfException);
    }
    return self.enableCollection(callback);
  },
  
  construct: function(self, options) {

    self.endpoint = '/api/v' + (options.version || 1);
        
    // Exclude the REST APIs from CSRF protection. However,
    // this module will call the CSRF protection middleware
    // itself if a user is not present based on a bearer token.
    self.addCsrfException = function(exceptions) {
      exceptions.push(self.endpoint + '/**');
    };

    self.enableCollection = function(callback) {
      self.bearerTokensCollection = self.apos.db.collection('aposBearerTokens');
      return self.bearerTokensCollection.ensureIndex({ expires: 1 }, { expireAfterSeconds: 0 }, callback);
    };
    
    self.enableCorsHeaders = function() {
      self.apos.app.use(self.endpoint, cors());
    };
    
    self.addRoutes = function() {

      self.enableCorsHeaders();

      if (self.options.bearerTokens) {
        self.apos.app.use(self.bearerMiddleware);
        self.apos.app.post(self.endpoint + '/login', function(req, res) {
          var bearer;
          var user;
          return async.series([
            checkCredentials,
            insertToken
          ], function(err) {
            if (err) {
              return res.status((typeof(err) !== 'object') ? err : 500).send({ 'error': 'error' });
            } else {
              return res.send({ bearer: bearer });
            }
          });
          function checkCredentials(callback) {
            var username = self.apos.launder.string(req.body.username);
            var password = self.apos.launder.string(req.body.password);
            if (!(username && password)) {
              return callback(400);
            }
            return self.apos.login.verifyLogin(username, password, function(err, _user) {
              if (err) {
                return callback(err);
              }
              if (!_user) {
                return callback(401);
              }
              user = _user;
              return callback(null);
            });
          }
          function insertToken(callback) {
            bearer = cuid();
            return self.bearerTokensCollection.insert({
              _id: bearer,
              userId: user._id,
              expires: new Date(new Date().getTime() + (self.options.bearerTokens.lifetime || (86400 * 7 * 2)) * 1000)
            }, callback);
          }
        });
        self.apos.app.post(self.endpoint + '/logout', function(req, res) {
          if (!req.user) {
            return res.status(403).send({ forbidden: 'forbidden' });
          }
          return self.bearerTokensCollection.remove({
            userId: req.user._id,
            _id: req.token
          }, function(err) {
            if (err) {
              return res.status(500).send({ error: 'error' });
            }
            return res.send({});
          });
        });
      }

      self.apos.app.post(self.endpoint + '/attachments', self.apos.attachments.middleware.canUpload, self.apos.middleware.files, function(req, res) {
        var userAgent = req.headers['user-agent'];
        var matches = userAgent && userAgent.match(/MSIE (\d+)/);
        if (matches && (matches[1] <= 9)) {
          // Must use text/plain for file upload responses in IE <= 9,
          // don't do that to other browsers
          res.header("Content-Type", "text/plain");
        }
        // The name attribute could be anything because of how fileupload
        // controls work; we don't really care.
        var file = _.values(req.files || {})[0];
        if (!file) {
          return res.status(400).send({ error: 'no file sent, did you forget to use multipart/form-data encoding?' });
        }
        return self.apos.attachments.accept(req, file, function(err, file) {
          if (err) {
            console.error(err);
            return res.status(500).send({ status: 'error' });
          }
          return res.send(file);
        });
      });

    };
    
    // Instantiate the express-bearer-token middleware for use
    // in parsing bearer tokens. Configuration may be passed to it via
    // the `expressBearerToken` option.
    self.bearerTokenMiddleware = expressBearerToken(self.options.expressBearerToken || {});
    
    // The `bearerMiddleware` method is Express middleware
    // that detects a bearer token per RFC6750 and
    // sets `req.user` exactly as the `apostrophe-login`
    // module would. Extends the `express-bearer-token`
    // middleware to actually set `req.user`. If there
    // is no token or it is invalid we just don't set
    // `req.user` (it's an anonymous access).
    //
    // If a user is not assigned via a bearer token,
    // Apostrophe's standard CSRF middleware is invoked
    // to ensure that API accesses by logged-in website users
    // are not vulnerable to CSRF attacks.
    
    self.bearerMiddleware = function(req, res, next) {
      if (req.url.substr(0, self.endpoint.length + 1) !== (self.endpoint + '/')) {
        return next();
      }
      if (req.url === self.endpoint + '/login') {
        // Login is exempt, chicken and egg
        return next();
      }
      
      self.bearerTokenMiddleware(req, res, function() {
        var userId, user;
        if (!req.token) {
          return self.apos.modules['apostrophe-express'].csrfWithoutExceptions(req, res, next);
        }
        return async.series([
          getBearer,
          deserializeUser
        ], function(err) {
          if (err) {
            console.error(err);
            return res.status(500).send({ 'error': 'error' });
          }
          if (!user) {
            return res.status(401).send({ 'error': 'bearer token invalid' });
            return self.apos.modules['apostrophe-express'].csrfWithoutExceptions(req, res, next);
          }
          req.user = user;
          return next();
        });
        
        function getBearer(callback) {
          // The expireAfterSeconds feature of mongodb
          // is not instantaneous so we should check
          // "expires" ourselves too
          return self.bearerTokensCollection.findOne({
            _id: req.token,
            expires: { $gte: new Date() }
          }, function(err, bearer) {
            if (err) {
              return callback(err);
            }
            userId = bearer && bearer.userId;
            return callback(null);
          });
        }
        function deserializeUser(callback) {
          if (!userId) {
            return callback(null);
          }
          return self.apos.login.deserializeUser(userId, function(err, _user) {
            if (err) {
              return callback(err);
            }
            user = _user;
            return callback(null);
          });
        }
      });
    };
  }

};
