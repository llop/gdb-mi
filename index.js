//-----------------------------------------------------------
// Modules
//-----------------------------------------------------------

var spawn = require('child_process').spawn;
var events = require('events');
var fs = require('fs');
var mknod = require('mknod');
var os = require('os');
var path = require('path');
var gdbParser = require('gdb-mi-parser');



//function stringStartsWith(str, prefix) {
//  return str.slice(0, prefix.length)==prefix;
//}
function isEmpty(str) {
  return !str || 0===str.length;
}
function trim(str) {
  if (str) str = str.trim();
  return str;
}


function back(arr) {
  if (arr && arr.length>0) return arr[arr.length-1];
  return undefined;
}


// lines' first character tells us what type of gdb output event we have to fire
var outputTypeToGdbEvent = {
  'console': 'gdbConsoleOut',       // these are the 'stream records'
  'log': 'gdbInternalsOut',         // they are usually junk
  'target': 'gdbTargetOut',
  
  'result': 'gdbCommandResponse',   // these are the 'async record'
  'exec': 'gdbStateChange',         // to simplify, let's call these 2 'exec out records'
  
  'notify': 'gdbInfo',              // and these 2 'notify out records'
  'status': 'gdbProgress'
};

// This array only allows up to a certain number of elements
function BArray(maxElems) {
  Array.call(this);
  Object.setPrototypeOf(BArray.prototype, Array.prototype);
  BArray.prototype.push = function(value) {
    while (this.length>=maxElems) this.shift();
    return Array.prototype.push.call(this, value);
  };
}


function randTempFilePath() {
  var now = new Date();
  var rn = Math.round(Math.random()*1e9);
  var filename = ["gdb-fifo-", now.getYear(), now.getMonth(), now.getDate(), '-', rn].join('');
  return os.tmpdir() + path.sep + filename;
}


function back(arr) {
  if (arr && arr.length>0) return arr[arr.length-1];
  return undefined;
}


//-----------------------------------------------------------
// Main gdb instance
// 
// https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-General-Design.html#GDB_002fMI-General-Design
// 
//-----------------------------------------------------------

function nodeGdb(gdbArgs) {
  
  //----------------------------------------------------------------------------------
  //
  // private variables
  // 
  //----------------------------------------------------------------------------------
  
  var me = this;                            // reference to this instance for callbacks
  
  var interactive = false;                  // when true, more commands can be issued to gdb
  var gdbInteractiveCallback = undefined;   // function that will be called after GDB has 
                                            // executed a command and gone back to interactive mode  
  
  var debugStatus = 'idle';                 // 'active' or 'idle': do not allow for more than 1 debug at a time
  
  var execStatus = 'stopped';               // https://sourceware.org/gdb/onlinedocs/gdb/GDB_002fMI-Async-Records.html#GDB_002fMI-Async-Records
                                            // execution status can be 'running' or 'stopped' (breakpoint, SIGINT, ...)
  
  var commadQueue = [];                     // commands to be executed
  
  var streamRecords = new BArray(100);      // save last hundred records here
  var execOutRecords = new BArray(100);
  var notifyOutRecords = new BArray(100);
  
  var processes = [];                       // debugee's PID and thread group id
  
  
  //----------------------------------------------------------------------------------
  //
  // ready event handling (nodeGdb needs to do some setup before it can be used)
  //
  //----------------------------------------------------------------------------------

  // we'll emit the ready event when we have:
  //  - created the 3 FIFOs for the debugee's IO
  //  - gdb has signaled it's ready for input
  var fifoCnt = 0;
  var gdbReady = false;
  var readyEmitted = false;
  var readyCalledOnce = false;
  var readyFunc = undefined;
  
  function readyCheck() {
    if (!readyEmitted && readyFunc && gdbReady && fifoCnt==3) {
      readyEmitted = true;
      readyFunc();
      readyFunc = undefined;
    }
  }
  
  // sets a callback that gets invoked once after the class is ready to be used
  nodeGdb.prototype.ready = function(callback) {
    if (!readyCalledOnce) {
      readyCalledOnce = true;
      readyFunc = callback;
      readyCheck();
    }
  };
  
  
  //-----------------------------------------------------------
  // private functions
  //-----------------------------------------------------------
  
  // issues the given command if possible (interactive mode), otherwise enqueues it for later execution
  // args is an array containing command arguments
  // callback is a function that will get executed when the debugger goes back to interactive mode
  // return value indicates if the command got through to the debugger
  function enqueueCommand(name, args, callback) {
    function commandFunc() {
      interactive = false;
      gdbInteractiveCallback = callback;
      var cmd = name + ' ' + args.join(' ') + '\n';
      //console.log("CMD: "+cmd);
      gdbIn.write(cmd);
    };
    if (interactive) commandFunc();
    else commadQueue.push(commandFunc);
  };
  
  // run the next command in the queue
  function execNextQueuedCommand() {
    if (interactive && commadQueue.length>0) {
      var nextCommand = commadQueue.shift();
      nextCommand();
    }
  }
  
  // execute the last issued command's callback
  function execCommandCallback() {
    var callback = gdbInteractiveCallback;
    var result = back(execOutRecords);
    gdbInteractiveCallback = undefined;
    callback(result);
  }
  
  function processStreamRecord(result) {
    // just log
    streamRecords.push(result);
  }
  
  function processNotifyOutput(result) {
    // store PID and thread group id of the debugee
    if (result.outputType=='notify') {
      if (result.class=='thread-group-started') {
        var programPid = result.result.pid;
        var threadGroupId = result.result.id;
        processes.push({ pid: programPid, id: threadGroupId });
        //console.log("ID: " + programPid + ' ' + threadGroupId);
      } else if (result.class=='thread-group-exited') {
        // we can to catch when the debugger has stopped here, and update 'debugStatus'
        debugStatus = 'idle';
      }
    }
    // log
    notifyOutRecords.push(result);
  }
  
  // some things need special handling, such as process PIDs, and status updates
  // based on output type
  function processAsyncOutput(result) {
    // handle state changes if prefix is line was exec-async-output ('stopped' or 'running')
    if (result.outputType=='exec') execStatus = result.class;
    // log
    execOutRecords.push(result);
  }
  
  function enteredInteractiveMode() {
    interactive = true;
    gdbReady = true;
    readyCheck();
  }
  
  // parse a line of gdb output. the content of that line determines what we do:
  // "(gdb)" -> tells us the debugger is back in interactive mode
  //            run the originating command's callback
  // otherwise it's a regular output line we'll parse into JSON
  function processGdbMiResult(result) {
    if (!result) return;
    if (result.recordType=='stream') processStreamRecord(result);
    else {
      if (result.outputType=='status'||result.outputType=='notify') processNotifyOutput(result);
      else processAsyncOutput(result);
    }
    // fire gdb output event
    var event = outputTypeToGdbEvent[result.outputType];
    me.emit(event, result);
  };
  
  function processGdbMiOutput(data) {
    var result = gdbParser(data);
    for (var i = 0; i < result.outOfBandRecords.length; ++i) 
      processGdbMiResult(result.outOfBandRecords[i]);
    processGdbMiResult(result.resultRecord);
    // next command?
    if (result.hasTerminator) {
      enteredInteractiveMode();
      if (gdbInteractiveCallback) execCommandCallback();  // run callback if present
      else execNextQueuedCommand();                       // execute next command in queue, if possible
    }
  };
  
  
  
  //-------------------------------------------------------------------------
  // 
  // Program input functions
  // 
  //-------------------------------------------------------------------------
  
  // write right into program input stream
  nodeGdb.prototype.appInWrite = function(str) {
    appIn.write(str);
  };
  
  // pipe a readble into program input stream
  nodeGdb.prototype.pipeToAppIn = function(readable) {
    readable.pipe(appIn);
  };
  
  
  //-------------------------------------------------------------------------
  // 
  // Execution methods
  // 
  //-------------------------------------------------------------------------
  
  // callback( data )
  nodeGdb.prototype.load = function(programName, programArgs, callback) {
    // do not mess around with this while debugging another program!
    if (debugStatus=='active') {
      callback({ error: 'Cannot load another program while debugging' });
      return;
    }
    
    // sanitize vars
    programName = programName || "";
    programArgs = programArgs || [];
    
    // add IO redirection to program args
    // if there's IO redirection lurking in there, it will have no effect
    var ioArgs = [ '<', appInFileName, '>', appOutFileName, '2>', appErrFileName ];
    programArgs = programArgs.concat(ioArgs);
    
    // -file-exec-and-symbols -> Specify the executable file to be debugged. 
    // This file is the one from which the symbol table is also read. If no file is specified, 
    // the command clears the executable and symbol information. If breakpoints are set 
    // when using this command with no arguments, gdb will produce error messages. 
    // Otherwise, no output is produced, except a completion notification.
    // 
    // -exec-arguments -> Set the inferior program arguments, to be used in the next `-exec-run'.
    // If any args had been set before, they get wiped.
    enqueueCommand("-file-exec-and-symbols", [programName], function(data) {
      enqueueCommand("-break-insert", ["main.cc:28"], function(data) {
        enqueueCommand("-exec-arguments", programArgs, callback);
      });
    });
  };
  
  // start the debug
  nodeGdb.prototype.run = function(args, callback) {
    // debug one program at a time!
    if (debugStatus=='active') {
      callback({ error: 'Already debugging a program' });
      return;
    }
    debugStatus = 'active';
    
    // will stream user input into program input channel
    // we need to open these every time we start a debug, cos the previous one closed our streams
    appIn = fs.createWriteStream(appInFileName, {encoding: 'utf8'});
    appOut = fs.createReadStream(appOutFileName, {encoding: 'utf8'});
    appErr = fs.createReadStream(appErrFileName, {encoding: 'utf8'});
    
    // debugee IO
    me.appStdin = appIn;
    me.appStdout = appOut;
    me.appStderr = appErr;
    me.appStdio = [appIn,appOut,appErr];
    
    // wire program out events
    appOut.on("data", function(data) {
      me.emit("appOut", data);
    });
    appErr.on("data", function(data) {
      me.emit("appErr", data);
    });
    
    // -exec-run -> Asynchronous command. Starts execution of the inferior from the beginning. 
    // The inferior executes until either a breakpoint is encountered or the program exits.
    enqueueCommand("-exec-run", args, callback);
  };
  
  nodeGdb.prototype.continue = function(args, callback) {
    // make sure we have started debugging something and we are on pause (status 'stopped')
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is already running' });
      return;
    }
    
    // exec-continue -> Asynchronous command. Resumes the execution of the inferior program 
    // until a breakpoint is encountered, or until the inferior exits.
    enqueueCommand("-exec-continue", args, callback);
  };
  
  nodeGdb.prototype.pause = function(callback) {
    // make sure we have started debugging something and we are 'running'
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='stopped') {
      callback({ error: 'Program is already stopped' });
      return;
    }
    
    // Could we do: enqueueCommand("-exec-interrupt", [], callback); to pause? 
    // No: gdb will not accept that command if debugee is running
    // Workaround: enqueue kill command
    function commandFunc() {
      interactive = false;
      gdbInteractiveCallback = callback;
      for (var i = 0; i < processes.length; ++i) {
        // kill the debugee (it is really only 'interrupted')
        var programPid = processes[i].pid;
        exec("kill -s 2 " + programPid);
      }
    };
    if (interactive) commandFunc();
    else commadQueue.push(commandFunc);
  };
  
  nodeGdb.prototype.stop = function(callback) {
    // if not running, u r stupid
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    
    // really kill the debugee
    // if program is running, we need to interrupt it first so gdb goes back to interactive
    if (execStatus=='running') {
      me.pause(function(data) {
        enqueueCommand("kill", [], callback);
      });
    } else {
      enqueueCommand("kill", [], callback);
    }
  };
  
  //-------------------------------------------------------------------------
  // Step methods
  //-------------------------------------------------------------------------
  nodeGdb.prototype.stepOver = function(args, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot step over' });
      return;
    }
    // -exec-next -> Asynchronous command. Resumes execution of the inferior program, 
    // stopping when the beginning of the next source line is reached.
    enqueueCommand("-exec-next", args, callback);
  };
  
  nodeGdb.prototype.stepInto = function(args, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot step into' });
      return;
    }
    // -exec-step -> Asynchronous command. Resumes execution of the inferior program, 
    // stopping when the beginning of the next source line is reached, 
    // if the next source line is not a function call. 
    // If it is, stop at the first instruction of the called function
    enqueueCommand("-exec-step", args, callback);
  };
  
  nodeGdb.prototype.stepOut = function(args, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot step out' });
      return;
    }
    // -exec-finish -> Asynchronous command. Resumes the execution of the inferior program 
    // until the current function is exited. 
    // Displays the results returned by the function
    enqueueCommand("-exec-finish", args, callback);
  };
  
  
  //-------------------------------------------------------------------------
  // 
  // Query methods
  // 
  //-------------------------------------------------------------------------
  
  nodeGdb.prototype.evalExpression = function(expr, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot eval expression' });
      return;
    }
    
    // -data-evaluate-expression -> Evaluate expr as an expression. The expression 
    // could contain an inferior function call. The function call will execute synchronously. 
    // If the expression contains spaces, it must be enclosed in double quotes.
    enqueueCommand("-data-evaluate-expression", [expr], callback);
  };
  
  nodeGdb.prototype.setVariableValue = function(varName, varValue, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot set variable value' });
      return;
    }
    
    // https://sourceware.org/gdb/current/onlinedocs/gdb/Assignment.html
    // To alter the value of a variable, evaluate an assignment expression
    enqueueCommand("-data-evaluate-expression", [varName+"="+varValue], callback);
  };
  
  
  //-------------------------------------------------------------------------
  // 
  // Breakpoint methods
  // 
  //-------------------------------------------------------------------------
  
  nodeGdb.prototype.insertBreakpoint = function(args, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot insert breakpoint' });
      return;
    }
    // -break-insert -> inserts a breakpoint
    enqueueCommand("-break-insert", args, callback);
  };
  nodeGdb.prototype.enableBreakpoints = function(breakpoints, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot enable breakpoints' });
      return;
    }
    // -break-enable -> Enable (previously disabled) breakpoint(s)
    enqueueCommand("-break-enable", breakpoints, callback);
  };
  
  nodeGdb.prototype.deleteBreakpoints = function(breakpoints, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot delete breakpoints' });
      return;
    }
    // -break-delete -> Delete the breakpoint(s) whose number(s) are specified in the argument list. 
    // This is obviously reflected in the breakpoint list.
    enqueueCommand("-break-delete", breakpoints, callback);
  };
  nodeGdb.prototype.disableBreakpoints = function(breakpoints, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot disable breakpoints' });
      return;
    }
    // -break-disable -> Disable the named breakpoint(s). 
    // The field `enabled' in the break list is now set to `n' for the named breakpoint(s).
    enqueueCommand("-break-disable", breakpoints, callback);
  };
  nodeGdb.prototype.listBreakpoints = function(breakpoints, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot disable breakpoints' });
      return;
    }
    // -break-list -> Displays the list of inserted breakpoints
    enqueueCommand("-break-list", breakpoints, callback);
  };
  
  
  
  // set args = ["2"] to get more data
  // use the --frame option to select frame --frame 0
  nodeGdb.prototype.listVariables = function(args, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot list variables' });
      return;
    }
    // -stack-list-variables -> Display the names of local variables and function arguments for the 
    // selected frame. If print-values is 0 or --no-values, print only the names of the variables; if it 
    // is 1 or --all-values, print also their values; and if it is 2 or --simple-values, print the name, 
    // type and value for simple data types, and the name and type for arrays, structures and unions. 
    enqueueCommand("-stack-list-variables", args, callback);
  };
  
  nodeGdb.prototype.callStack = function(args, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot get call stack' });
      return;
    }
    // -stack-list-frames -> List the frames currently on the stack
    enqueueCommand("-stack-list-frames", args, callback);
  };
  
  nodeGdb.prototype.selectedFrameInfo = function(callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot get info about selected frame' });
      return;
    }
    // -stack-info-frame -> Get info on the selected frame
    enqueueCommand("-stack-info-frame", [], callback);
  };
  
  nodeGdb.prototype.setSelectedFrame = function(framenum, callback) {
    // error check
    if (debugStatus=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (execStatus=='running') {
      callback({ error: 'Program is running, cannot get info about selected frame' });
      return;
    }
    // -stack-select-frame -> Change the selected frame. Select a different frame framenum on the stack
    enqueueCommand("-stack-select-frame", [framenum], callback);
  };
  
  
  //-----------------------------------------------------------
  // make this an event emitter
  //-----------------------------------------------------------
  
  // events: 
  // GDB output events:
  // 'gdbConsoleOutput',
  // 'gdbInternalsOutput',
  // 'gdbStateChange',
  // 'gdbInfo',
  // 'gdbCommandResponse',
  // 'gdbProgress'
  // General app and gdb output events
  // 'appOut'
  // 'appErr'
  // 'gdbOut'
  // 'gdbErr'
  // gdb process events
  // 'close'
  // 'exit'
  // 'error'
  events.EventEmitter.call(me);
  //nodeGdb.prototype.__proto__ = events.EventEmitter.prototype;              // DEPRECATED!
  Object.setPrototypeOf(nodeGdb.prototype, events.EventEmitter.prototype);    // use this instead
  
  
  //-----------------------------------------------------------
  // set up program IO
  //-----------------------------------------------------------
  
  // fifo files
  var fifoPath = randTempFilePath();
  var appInFileName = fifoPath + ".in";
  var appOutFileName = fifoPath + ".out";
  var appErrFileName = fifoPath + ".err";
  
  // fifos cleanup
  var fifosClosed = false;
  function closeFifos() {
    if (!fifosClosed) {
      fifosClosed = true;
      // delete debugee IO FIFOs
      fs.unlink(appInFileName);
      fs.unlink(appOutFileName);
      fs.unlink(appErrFileName);
    }
  }
  
  // Create a fifo with read/write permissions for owner, and with read permissions for group and others
  // Mode: 4516 (S_IFIFO | S_IWUSR | S_IRUSR | S_IRGRP | S_IROTH)
  // Device: 0 (dev_t)
  function mknodHandler(err) {
    if (err) throw err;
    ++fifoCnt;
    readyCheck();
  }
  mknod(appInFileName, 4516, 0, mknodHandler);
  mknod(appOutFileName, 4516, 0, mknodHandler);
  mknod(appErrFileName, 4516, 0, mknodHandler);
  
  var appIn;    // IO streams we'll use to comunicate with the debugee
  var appOut;
  var appErr;
    
  
  //-----------------------------------------------------------
  // set up debugger (gdb)
  // 
  // nodeGdb looks like a regular ChildProcess, and can be treated as such
  //
  //   Event: 'close'
  //   Event: 'disconnect'
  //   Event: 'error'
  //   Event: 'exit'
  //   Event: 'message'
  //   child.connected
  //   child.disconnect()
  //   child.kill([signal])
  //   child.pid
  //   child.send(message[, sendHandle][, callback])
  //   child.stderr
  //   child.stdin
  //   child.stdio
  //   child.stdout
  //   
  // Additional accessors are provided to separate gdb IO from debugee IO
  // 
  //   gdbStdio
  //   gdbStdin
  //   gdbStdout
  //   gdbStderr
  //   appStdin
  //   appStdout
  //   appStderr
  //   appStdio
  //-----------------------------------------------------------
  // prep GDB args
  gdbArgs = gdbArgs || [];
  // Hardcoded args
  gdbArgs = gdbArgs.concat("--interpreter=mi");   // Use MI interpreter
  //gdbArgs = gdbArgs.concat("--readnow");          // Fully read symbol files on first access.
  //gdbArgs = gdbArgs.concat("-tty=/dev/pts/5");    // set terminal
  //gdbArgs = gdbArgs.concat("--args");             // DO NOT USE!!! Program arguments should go in the 'programArgs' array

  // spawn gdb process and wire process events
  var gdb = spawn("gdb", gdbArgs, { detached: true });
  
  // wire ChildProcess-like event handlers
  gdb.on("close", function(code, signal) {
    me.emit("close", code, signal);
  });
  gdb.on("exit", function(code, signal) {
    closeFifos();
    me.emit("exit", code, signal);
  });
  gdb.on("error", function(err) {
    closeFifos();
    me.emit("error", err);
  });
  gdb.on("disconnect", function(err) {
    me.emit("disconnect", err);
  });
  gdb.on("message", function(message, sendHandle) {
    me.emit("message", message, sendHandle);
  });
  
  
  // make ChildProcess-like methods
  nodeGdb.prototype.disconnect = function() {
    return gdb.disconnect();
  };
  nodeGdb.prototype.kill = function(signal) {
    return gdb.kill(signal);
  };
  nodeGdb.prototype.send = function(message, sendHandle, callback) {
    return gdb.send(message, sendHandle, callback);
  };
  // make ChildProcess-like properties
  me.pid = gdb.pid;
  me.connected = gdb.connected;
  
  // general IO
  me.stdio = gdb.stdio;
  me.stdin = gdb.stdin;
  me.stdout = gdb.stdout;
  me.stderr = gdb.stderr;
  
  
  // gdb IO
  me.gdbStdio = gdb.stdio;
  me.gdbStdin = gdb.stdin;
  me.gdbStdout = gdb.stdout;
  me.gdbStderr = gdb.stderr;
  
  // debugee IO
  me.appStdin = undefined;
  me.appStdout = undefined;
  me.appStderr = undefined;
  me.appStdio = [undefined,undefined,undefined];
  
  
  // gdb IO
  var gdbIn = gdb.stdin;    // all these are sockets
  var gdbOut = gdb.stdout;
  var gdbErr = gdb.stderr;
  
  // wire gdb out events
  gdbOut.on("data", function(data) {
    processGdbMiOutput(data);
    me.emit("gdbOut", data);
  });
  gdbErr.on("data", function(data) {
    processGdbMiOutput(data);
    me.emit("gdbErr", data);
  });
  
}


module.exports = nodeGdb;
