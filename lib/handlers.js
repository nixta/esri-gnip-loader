var uuid = require('node-uuid'),
    _ = require('lodash'),
    async = require('async'),
    request = require('request');

var writers = require('./writers'),
    readers = require('./readers'),
    querySession = require('./query-session'),
    wq = require('./write-queue');

var Portal = require('./portal');

var qsStatus = require('./query-session-status'),
    pageStatus = require('./page-status');

var env = process.env.NODE_ENV = process.env.NODE_ENV || 'development';
var mock = process.env.MOCK = process.env.MOCK || '';

function sendError(res, err) {
  var noLog,
      error = {
        error: err
      },
      code = 400,
      argBase = 2;
  if (err === parseInt(err)) {
    code = err;
    if (arguments.length > 2) {
      err = arguments[2];
      argBase = 3;
    } else {
      err = 'Unknown error';
    }
  }

  if (arguments.length > argBase && arguments.length <= argBase+2) {
    for (var i=argBase; i < arguments.length; i++) {
      var arg = arguments[i];
      switch ({}.toString.call(arg)) {
        case '[object Boolean]':
          noLog = arg;
          break;
        case '[object Object]':
          error.payload = arg;
          break;
      }
    }
  }
  if (!noLog) {
    console.error(err);
  }
  res.status(code).send(error);
}

function getQuery(req) {
  var query = {
    query: req.body.query,
    fromDate: req.body.fromDate,
    toDate: req.body.toDate,
    maxResults: req.body.maxResults,
    requestLimit: req.body.requestLimit,
    bucket: req.body.bucketSize
  };

  for (var k in query) {
    if (query[k] === undefined) {
      delete query[k];
    } else if ((k === 'fromDate' || k === 'toDate') && 
               (query[k] === null || query[k] === '')) {
      delete query[k];
    }
  }
  return query;
}

function __readsFinished(err, allRecords, qs) {
  qs.reading = false;
  qs.readProgress = 100;
  console.time('Queue');
  if (!err) {
    console.log('Read all ' + allRecords.length + ' records.');
    qs.gnipRecords = allRecords;
  } else {
    qs.status = qsStatus.Finished;
    qs.error = err;
    sendError(res, 'Error executing query.', err);
  }
}

var portals = {};

function handleCreateFeatureService(req, res) {
  var name = req.body.name,
      token = req.body.token,
      logKey = 'Create FeatureService ' + name;

  console.time(logKey);

  var p = portals[token];
  if (p !== undefined) {
    newFS(p, name);
  } else {
    p = new Portal(token);

    p.on('load', function(portal) {
      portals[token] = portal;
      newFS(portal, name);
    });

    p.on('error', function (err) {
      delete portals[token];
      sendError(res, 'Error creating feature service ' + fsName, err);
    });
  }

  function newFS (portal, fsName) {
    console.log('Creating feature service ' + fsName);
    return portal.createGnipFeatureService(name)
      .then(function (fsInfo) {
        console.timeEnd(logKey);
        console.log('Created ' + fsName + ' OK!');
        res.status(200).send(fsInfo);
      })
      .fail(function (err) {
        console.timeEnd(logKey);
        console.error('Error creating ' + fsName + ': ' + err);
        sendError(res, 'Error creating ' + fsName + ': ' + err);
      });
  }
}

function handlePushQuery(req, res) {
  console.time('Process');

  var qs = querySession.get(uuid.v1(), true);
  var gnipQuery = getQuery(req),
      requestLimit = gnipQuery.requestLimit || null;
  var writePageLimit = 50,
      concurrentOperations = 8;

  // Set up our writing queue.
  var writeQueue = async.queue(wq.writePage, concurrentOperations);
  writeQueue.drain = function() { wq.drain(qs); };

  qs.featureServiceUrl = req.body.featureServiceUrl;

  // Set out status to running, and then find a suitable esri-gnip writer.
  qs.status = qsStatus.Running;
  writers.getWriter(req, function (err, writer) {
    if (!err) {
      // Tell the caller that we've started.
      res.status(200).send(querySession.forOutput(qs));

      if (mock !== '') { return; }

      // We got a writer OK. Now read the records, page by page, writing them out as we get them.
      console.log('Executing query with limit ' + requestLimit);
      console.log(gnipQuery);

      // Get an existing GnipReader for this user in this session.
      var gnipReader = readers.getReader(req, res),
          abortReading = false;
      qs.reading = true;
      gnipReader.fullSearch(gnipQuery, requestLimit, function pageQueried (gnipRecords, pageNumber, estimatedProgress) {
        // Got a page of Gnip records.
        qs.readProgress = estimatedProgress;

        // Break down the page of Gnip records into chunks small enough to write.
        var writePages = [],
            sliceIndex = 0;
        while (sliceIndex < gnipRecords.length) {
          var nextPage = gnipRecords.slice(sliceIndex, sliceIndex + writePageLimit);
          writePages.push(nextPage);
          sliceIndex += writePageLimit;
        }

        // Add each Write Page to the queue.
        for (var i=0; i<writePages.length; i++) {
          var pageId = pageNumber + '.' + i,
              pageRecords = writePages[i];

          // Add this page to the query session for tracking.
          qs.pages[pageId] = {
            pageId: pageId,
            status: pageStatus.Loaded,
            records: pageRecords
          };

          // Queue the page for processing.
          if (qs.queueStartTime === null) {
            qs.queueStartTime = new Date();
            qs.writing = true;
          }
          qs.gnipRecords = qs.gnipRecords.concat(pageRecords);
          console.log('Adding page ' + pageId + ' to queue with ' + pageRecords.length + ' records.');
          writeQueue.push({
            querySession: qs, 
            pageId: pageId,
            writer: writer,
            gnipRecords: pageRecords
          }, pageWriteCompleted);
        }

        // Yes, we want more pages please, if there are any.
        return !abortReading;

        // Function definition out of the way down here.
        function pageWriteCompleted (err) {
          if (err) {
            // Writing to the FS failed. Abort further writes (those in progress will complete).
            qs.err = err;
            console.log('Aborting further writes');
            qs.status = qsStatus.Finished;
            abortReading = true;
            writeQueue.kill();
          }
        }
      }, function readsFinished(err, allRecords) { 
        __readsFinished(err, allRecords, qs);
      });
    } else {
      qs.status = qsStatus.Finished;
      qs.reading = false;
      sendError(res, 'Error getting esri-gnip writer: ', err);
    }
  });
}

function writeDevOutput(qs, output) {
  if (env === 'development') {
    // We'll log the output to a folder and files within that folder.
    // Can use some of these files later for mock mode if need be.
    if (qs.hasOwnProperty('dev_count')) {
      qs.dev_count += 1;
    } else {
      qs.dev_count = 0;
    }

    var fs = require('fs'),
        folder = './test/temp-data/' + qs.id,
        filename = folder + '/' + qs.dev_count + '.json';

    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder);
    }

    fs.writeFile(filename, JSON.stringify(output, null, "  "), function(err) {
      if (!err) {
        console.log('Wrote output to ' + filename);
        // qs.writtenOutputToFile = true;
      } else {
        console.error('Failed to write output to ' + filename);
        console.error(err);
        // qs.writtenOutputToFile = false;
      }
    });
  }
}

var mockProgress = 0,
    mockStart = null;
function handleMock(req, res) {
  if (mock !== '') {

    if (mockProgress === 0) {
      mockStart = new Date();
    }
    if (mockProgress < 100) {
      // Pretend we're making some progress. Go from 0 to 100 in steps of 13.
      mockProgress += 13;
      if (mockProgress < 50) {
        // For the first few iterations, we'll return an error
        // to simulate an internal server error and ensure the client
        // is handling errors and retrying properly.
        sendError(res, 500, 'Server temporarily unavailable');
        return true;
      }
    } else {
      // Only football players can give more than 100%
      mockProgress = 100;
    }

    if (mockProgress === 100) {
      // Now load the data from the mock file
      var storedJson = require('../test/' + mock);
      res.status(200).send(storedJson.output);
      // Now we've sent the response, reset for next time.
      mockProgress = 0;
      mockStart = null;
    } else {
      // Still going, so send some mock progress reports.
      var progressResponse = {
          "id": req.query.queryId,
          "status": "running",
          "readProgress": 100,
          "writeProgress": mockProgress,
          "startTime": mockStart,
          "endTime": null
        };
      res.status(200).send(progressResponse);
    }

    return true;
  }
  return false;
}

function handleQueryStatus(req, res) {
  if (handleMock(req, res)) {
    // We're in mock mode. No need to do any real work.
    return;
  }

  var queryId = req.query.queryId;
  var qs = querySession.get(queryId),
      output = querySession.forOutput(qs);
  if (qs !== undefined) {
    writeDevOutput(qs, output);
    res.status(200).send(output);
  } else {
    res.status(400).send('Invalid query sesson ID: ' + queryId);
  }
}

function handleCount(req, res) {
  var query = getQuery(req);

  var bucketSize = query.bucket || 'hour';

  // Get an existing GnipReader for this user in this session.
  var gnipReader = readers.getReader(req, res);
  gnipReader.estimate(query, function(err, gnipEstimates) {
    if (!err) {
      res.status(200).send({
        bucketSize: bucketSize,
        buckets: gnipEstimates
      });
    } else {
      return sendError(res, 'Error getting counts for query.', err);
    }
  });
}

exports.handleCount = handleCount;
exports.handlePushQuery = handlePushQuery;
exports.handleQueryStatus = handleQueryStatus;
exports.handleCreateFeatureService = handleCreateFeatureService;