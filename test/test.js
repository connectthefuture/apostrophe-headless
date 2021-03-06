var assert = require('assert');
var request = require('request');
var cuid = require('cuid');
var _ = require('lodash');
var async = require('async');
var fs = require('fs-extra');

describe('test apostrophe-headless', function() {

  var apos;
  var adminGroup;
  var bearer;

  this.timeout(5000);

  after(function(done) {
    apos.db.dropDatabase(function(err) {
      if (err) {
        console.error(err);
      }
      fs.removeSync(__dirname + '/public/uploads/attachments');
      done();
    });
  });

  it('initializes', function(done) {
    apos = require('apostrophe')({
      testModule: true,
      
      modules: {
        'apostrophe-express': {
          secret: 'xxx',
          port: 7900
        },
        'apostrophe-headless': {
          bearerTokens: true
        },
        'products': {
          extend: 'apostrophe-pieces',
          restApi: true,
          name: 'product',
          addFields: [
            {
              name: 'body',
              type: 'area',
              options: {
                widgets: {
                  'apostrophe-rich-text': {},
                  'apostrophe-images': {}
                }
              }
            },
            {
              name: 'color',
              type: 'select',
              choices: [
                {
                  label: 'Red',
                  value: 'red'
                },
                {
                  label: 'Blue',
                  value: 'blue'
                }
              ]
            },
            {
              name: 'photo',
              type: 'attachment',
              group: 'images'
            }
          ]
        },
        'apostrophe-images': {
          restApi: true
        },
        'apostrophe-users': {
          groups: [
            {
              title: 'admin',
              permissions: [ 'admin' ]
            }
          ]
        }
      },
      afterInit: function(callback) {
        // Should NOT have an alias!
        assert(!apos.restApi);
        assert(apos.modules['products']);
        assert(apos.modules['products'].addRestApiRoutes);
        return callback(null);
      },
      afterListen: function(err) {
        assert(!err);
        done();
      }
    });
  });
  
  it('can locate the admin group', function(done) {
    return apos.docs.db.findOne({ title: 'admin', type: 'apostrophe-group' }, function(err, group) {
      assert(!err);
      assert(group);
      adminGroup = group;
      done();
    });
  });

  it('can insert a test user via apostrophe-users', function(done) {
    var user = apos.users.newInstance();

    user.firstName = 'test';
    user.lastName = 'test';
    user.title = 'test test';
    user.username = 'test';
    user.password = 'test';
    user.email = 'test@test.com';
    user.groupIds = [ adminGroup._id ];

    assert(user.type === 'apostrophe-user');
    assert(apos.users.insert);
    apos.users.insert(apos.tasks.getReq(), user, function(err) {
      assert(!err);
      done();
    });

  });    

  it('can log in via REST as that user, obtain bearer token', function(done) {
    http('/api/v1/login', 'POST', {}, {
      username: 'test',
      password: 'test'
    }, undefined, function(err, result) {
      assert(!err);
      assert(result && result.bearer);
      bearer = result.bearer;
      done();
    });
  });
  
  it('cannot POST a product without a bearer token', function(done) {
    http('/api/v1/products', 'POST', {}, {
      title: 'Fake Product',
      body: {
        type: 'area',
        items: [
          {
            type: 'apostrophe-rich-text',
            id: cuid(),
            content: '<p>This is fake</p>'
          }
        ]
      }
    }, undefined, function(err, response) {
      assert(err);
      done();
    });
  });
  
  var updateProduct;
  
  it('can POST products with a bearer token, some published', function(done) {
    // range is exclusive at the top end, I want 10 things
    var nths = _.range(1, 11);
    return async.eachSeries(nths, function(i, callback) {
      http('/api/v1/products', 'POST', {}, {
        title: 'Cool Product #' + i,
        published: !!(i & 1),
        body: {
          type: 'area',
          items: [
            {
              type: 'apostrophe-rich-text',
              id: cuid(),
              content: '<p>This is thing ' + i + '</p>'
            }
          ]
        }
      }, bearer, function(err, response) {
        assert(!err);
        assert(response);
        assert(response._id);
        assert(response.title === 'Cool Product #' + i);
        assert(response.slug === 'cool-product-' + i);
        assert(response.type === 'product');
        if (i === 1) {
          updateProduct = response;
        }
        return callback(null);
      });
    }, function(err) {
      assert(!err);
      done();
    });
  });

  it('can GET five of those products without a bearer token', function(done) {
    return http('/api/v1/products', 'GET', {}, {}, undefined, function(err, response) {
      assert(!err);
      assert(response);
      assert(response.results);
      assert(response.results.length === 5);
      done();
    });
  }); 

  it('Request with an invalid bearer token is a 401, even if it would otherwise be publicly accessible', function(done) {
    return http('/api/v1/products', 'GET', {}, {}, 'madeupbearertoken', function(err, response) {
      assert(err);
      assert(err.status === 401);
      assert(err.body.error);
      assert(err.body.error === 'bearer token invalid');
      done();
    });
  }); 

  it('can GET five of those products with a bearer token and no query parameters', function(done) {
    return http('/api/v1/products', 'GET', {}, {}, bearer, function(err, response) {
      assert(!err);
      assert(response);
      assert(response.results);
      assert(response.results.length === 5);
      done();
    });
  });

  it('can GET all ten of those products with a bearer token and published: "any"', function(done) {
    return http('/api/v1/products', 'GET', { published: "any" }, {}, bearer, function(err, response) {
      assert(!err);
      assert(response);
      assert(response.results);
      assert(response.results.length === 10);
      done();
    });
  });

  var firstId;
  
  it('can GET only 5 if perPage is 5', function(done) {
    http('/api/v1/products', 'GET', { perPage: 5, published: 'any' }, {}, bearer, function(err, response) {
      assert(!err);
      assert(response);
      assert(response.results);
      assert(response.results.length === 5);
      firstId = response.results[0]._id;
      assert(response.pages === 2);
      done();
    });
  });

  it('can GET a different 5 on page 2', function(done) {
    http('/api/v1/products', 'GET', { perPage: 5, published: 'any', page: 2 }, {}, bearer, function(err, response) {
      assert(!err);
      assert(response);
      assert(response.results);
      assert(response.results.length === 5);
      assert(response.results[0]._id !== firstId);
      assert(response.pages === 2);
      done();
    });
  });

  it('can update a product', function(done) {
    http('/api/v1/products/' + updateProduct._id, 'PUT', {}, _.assign(
      {}, 
      updateProduct,
      {
        title: 'I like cheese',
        _id: 'should-not-change'
      }
    ), bearer, function(err, response) {
      assert(!err);
      assert(response);
      assert(response._id === updateProduct._id);
      assert(response.title === 'I like cheese');
      assert(response.body.items.length);
      done();
    });
  });

  it('fetch of updated product shows updated content', function(done) {
    http('/api/v1/products/' + updateProduct._id, 'GET', {}, {}, bearer, function(err, response) {
      assert(!err);
      assert(response);
      assert(response.title === 'I like cheese');
      assert(response.body.items.length);
      done();
    });
  });
  
  it('can delete a product', function(done) {
    http('/api/v1/products/' + updateProduct._id, 'DELETE', {}, {}, bearer, function(err, response) {
      assert(!err);
      done();
    });
  });
  
  it('cannot fetch a deleted product', function(done) {
    http('/api/v1/products/' + updateProduct._id, 'GET', {}, {}, bearer, function(err, response) {
      assert(err);
      done();
    });
  });
  
  var attachment;
  var productWithPhoto;
  
  it('can post an attachment', function(done) {
    return request({
      url: 'http://localhost:7900/api/v1/attachments',
      method: 'POST',
      formData: {
        file: fs.createReadStream(__dirname + '/test-image.jpg')
      },
      json: true,
      auth: { bearer: bearer }    
    }, function(err, response, body) {
      assert(!err);
      assert(response.statusCode < 400);
      assert(typeof(body) === 'object');
      assert(body._id);
      attachment = body;
      done();
    });
  });
  
  it('can upload a product containing an attachment', function(done) {
    http('/api/v1/products', 'POST', {}, {
      title: 'Product With Photo',
      body: {
        type: 'area',
        items: [
          {
            type: 'apostrophe-rich-text',
            id: cuid(),
            content: '<p>Has a Photo</p>'
          }
        ]
      },
      photo: attachment
    }, bearer, function(err, response) {
      assert(!err);
      assert(response);
      productWithPhoto = response;
      done();
    });
  });

  it('can GET a product containing an attachment and it has image URLs', function(done) {
    http('/api/v1/products/' + productWithPhoto._id, 'GET', {}, undefined, undefined, function(err, response) {
      assert(!err);
      assert(response);
      assert(response._id === productWithPhoto._id);
      assert(response.photo);
      assert(response.photo._id === attachment._id);
      assert(response.photo._urls);
      assert(response.photo._urls.original);
      assert(response.photo._urls.full);
      done();
    });
  });

  it('can log out to destroy a bearer token', function(done) {
    http('/api/v1/logout', 'POST', {}, {}, bearer, function(err, result) {
      assert(!err);
      done();
    });
  });

  it('cannot POST a product with a logged-out bearer token', function(done) {
    http('/api/v1/products', 'POST', {}, {
      title: 'Fake Product After Logout',
      body: {
        type: 'area',
        items: [
          {
            type: 'apostrophe-rich-text',
            id: cuid(),
            content: '<p>This is fake</p>'
          }
        ]
      }
    }, bearer, function(err, response) {
      assert(err);
      done();
    });
  });
   
});

function http(url, method, query, form, bearer, callback) {
  var args = {
    url: 'http://localhost:7900' + url,
    qs: query || undefined,
    form: ((method === 'POST') || (method === 'PUT')) ? form : undefined,
    method: method,
    json: true,
    auth: bearer ? { bearer: bearer } : undefined
  };
  return request(args, function(err, response, body) {
    if (err) {
      return callback(err);
    }
    if (response.statusCode >= 400) {
      return callback({ status: response.statusCode, body: body });
    }
    return callback(null, body);
  });
}
