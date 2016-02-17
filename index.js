//------------------------------------------------------------------------------
// 
// modules
// 
//------------------------------------------------------------------------------
var spawn = require('child_process').spawn;
var pty = require('pty.js');
var events = require('events');
var gdbParser = require('gdb-mi-parser');


//------------------------------------------------------------------------------
// 
// event lookup table
// 
//------------------------------------------------------------------------------
var outputTypeToGdbEvent = {
  'console': 'gdb-console-out',       // these are the 'stream records'
  'log':     'gdb-internals-out',     // they are usually junk
  'target':  'gdb-target-out',
  
  'result':  'gdb-command-response',  // these are the 'async record'
  'exec':    'gdb-state-change',      // to simplify, let's call these 2 'exec out records'
  
  'notify':  'gdb-info',              // and these 2 'notify out records'
  'status':  'gdb-progress'
};


//------------------------------------------------------------------------------
// 
// javascript gdb wrapper
// 
// What you need on your system:
// 
// * gdbserver (^7.10.1)
// 
// * gdb (^7.10.1)
//     
//   You MUST add this to your ~/.gdbinit file:
//     set pagination off
//     set non-stop on
//     
//   This sets gdb in non-stop mode (see 
//   https://sourceware.org/gdb/onlinedocs/gdb/Non_002dStop-Mode.html)
//   and allows '-exec-interrupt' to actually work!
//   
//------------------------------------------------------------------------------
function gdb() {
  var me = this;  // alias for this
  
  
  //----------------------------------------------------------------------------
  // 
  // private vars and methods are prefixed with an underscore
  // 
  //----------------------------------------------------------------------------
  
  //----------------------------------------------------------------------------
  // prefix commands with a token so we can invoke the right callback later
  //----------------------------------------------------------------------------
  var _token = 0;
  var _commandCallbacks = {};
  
  
  //----------------------------------------------------------------------------
  // 
  // public vars
  // 
  //----------------------------------------------------------------------------
  
  me.debuggerState = 'idle';      // 'idle' or 'active'
  me.executionState = 'stopped';  // 'stopped' or 'running'
  
  me.gdbMi = undefined;
  me.gdbserver = undefined;
  
  me.gdbStdin = undefined;
  me.gdbStdout = undefined;
  me.gdbStderr = undefined;
  me.gdbStdio = [me.gdbStdin, me.gdbStdout, me.gdbStderr];
  
  me.appStdin = undefined;
  me.appStdout = undefined;
  me.appStderr = undefined;
  me.appStdio = [me.appStdin, me.appStdout, me.appStderr];
  
  
  //----------------------------------------------------------------------------
  // 
  // make this an event emitter
  // 
  //----------------------------------------------------------------------------
  events.EventEmitter.call(me);
  //gdb.prototype.__proto__ = events.EventEmitter.prototype;        // DEPRECATED!
  Object.setPrototypeOf(gdb.prototype, events.EventEmitter.prototype);  // use this instead
  
  
  //----------------------------------------------------------------------------
  // 
  // private functions
  // 
  //----------------------------------------------------------------------------
  
  function _command(name, args, callback) {
    _commandCallbacks[_token] = callback;
    var cmd = _token.toString()+name+' '+args.join(' ')+'\n';
    ++_token;
    //console.log("CMD: "+cmd);
    me.gdbStdin.write(cmd);
  };
  
  function _processResultRecord(result) {
    // execute corresponding callback
    var token = result.token;
    var callback = _commandCallbacks[token];
    if (callback) callback(result);
    delete _commandCallbacks[token];
  }
  function _processStreamRecord(result) {
    // those are usually junk
    // ignore for now
  }
  function _processAsyncRecord(result) {
    if (result.outputType=='exec') {
      // update execution state
      me.executionState = result.class;
      me.emit('gdb-exec-state-change', me.executionState);
    } else if (result.outputType=='status') {
      
    } else if (result.outputType=='notify') {
      
    }
  }
  
  function _processGdbMiResult(result) {
    if (!result) return;
    // record type can be 'result', 'stream', or 'async'
    if (result.recordType=='result')      _processResultRecord(result);
    else if (result.recordType=='stream') _processStreamRecord(result);
    else if (result.recordType=='async')  _processAsyncRecord(result);
    // fire gdb event
    var event = outputTypeToGdbEvent[result.outputType];
    me.emit(event, result);
  };
  
  function _processGdbMiOutput(data) {
    var result = gdbParser(data);
    for (var i = 0; i < result.outOfBandRecords.length; ++i) 
      _processGdbMiResult(result.outOfBandRecords[i]);
    _processGdbMiResult(result.resultRecord);
  };
  
  
  gdb.prototype.reset = function() {
    if (me.gdbServer) exec("kill -9 " + me.gdbServer.pid);
    if (me.gdb) exec("kill -9 " + me.gdb.pid);
    me.gdbMi = undefined;
    me.gdbserver = undefined;
    me.debuggerState = 'idle';
    me.executionState = 'stopped';
  }
  
  
  //----------------------------------------------------------------------------
  //
  // ADVANCED USE: send any one command to gdb
  // 
  //----------------------------------------------------------------------------
  gdb.prototype.sendCommand = function(command, args, callback) {
    if (me.debuggerState=='idle') {
      callback({ error: 'You cannot issue a command if you are not debugging' });
      return;
    }
    _command(command, args, callback);
  };
  
  
  //----------------------------------------------------------------------------
  //
  // 
  // loads the debug session for the specified program
  // 
  //----------------------------------------------------------------------------
  gdb.prototype.load = function(programName, programArgs, callback) {
    // debug one program at a time!
    if (me.debuggerState=='active') {
      callback({ error: 'Already debugging a program' });
      return;
    }
    me.debuggerState='active';
    
    
    var comm = 'localhost:1234';
    // create the gdbserver + attach listeners
    var gdbserverArgs = [comm, programName].concat(programArgs);
    me.gdbserver = pty.spawn('gdbserver', gdbserverArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24
    });
    me.gdbserver.on("close", function(code, signal) {
      console.log("gdbserver close  "+code+' '+signal);
      //me.emit("gdbserver-close", code, signal);
    });
    me.gdbserver.on("exit", function(code, signal) {
      console.log("gdbserver exit "+code+' '+signal);
      me.emit("gdb-debug-state-change", 'idle');
      me.reset();
      //me.emit("gdbserver-exit", code, signal);
    });
    me.gdbserver.on("error", function(err) {
      console.log("gdbserver error "+err);
      //me.emit("gdbserver-error", err);
    });
    me.gdbserver.on("disconnect", function(err) {
      console.log("gdbserver disconnect "+err);
      //me.emit("gdbserver-disconnect", err);
    });
    me.gdbserver.on("message", function(message, sendHandle) {
      console.log("gdbserver message "+message+' '+sendHandle);
      //me.emit("gdbserver-message", message, sendHandle);
    });
    
    
    // create the debugger + attach listeners
    var gdbArgs = ['-i', 'mi'];
    me.gdbMi = spawn('gdb', gdbArgs, { detached: true });
    me.gdbMi.on("close", function(code, signal) {
      console.log("gdb close  "+code+' '+signal);
      //me.emit("gdb-close", code, signal);
    });
    me.gdbMi.on("exit", function(code, signal) {
      console.log("gdb exit "+code+' '+signal);
      //me.emit("gdb-exit", code, signal);
    });
    me.gdbMi.on("error", function(err) {
      console.log("gdb error "+err);
      //me.emit("gdb-error", err);
    });
    me.gdbMi.on("disconnect", function(err) {
      console.log("gdb disconnect "+err);
      //me.emit("gdb-disconnect", err);
    });
    me.gdbMi.on("message", function(message, sendHandle) {
      console.log("gdb message "+message+' '+sendHandle);
      //me.emit("gdb-message", message, sendHandle);
    });
    
    
    // provide handles for IO
    me.appStdin = me.gdbserver.stdin;                         // those are actually references to gdbserver itself!
    me.appStdout = me.gdbserver.stdout;
    me.appStderr = undefined;                                 // pty provides no stderr; actually, 
    me.appStdio = [me.appStdin, me.appStdout, me.appStderr];  // it throws a nice exception if you try to acess it!
    
    me.gdbStdin = me.gdbMi.stdin;
    me.gdbStdout = me.gdbMi.stdout;
    me.gdbStderr = me.gdbMi.stderr;
    me.gdbStdio = me.gdbMi.stdio;
    
    
    // process + emit output events
    me.appStdout.on("data", function(data) {
      me.emit("app-out", data);
    });
    me.gdbStdout.on("data", function(data) {
     me.emit("gdb-out", data);
      _processGdbMiOutput(data);
    });
    me.gdbStderr.on("data", function(data) {
      me.emit("gdb-err", data);
    });
    
    
    // -file-exec-and-symbols -> Specify the executable file to be debugged. 
    // This file is the one from which the symbol table is also read. 
    // If no file is specified, the command clears the executable and symbol information. 
    // If breakpoints are set when using this command with no arguments, gdb will produce error messages. 
    // Otherwise, no output is produced, except a completion notification.
    _command('-file-exec-and-symbols', [programName], function(data) {
      console.log("-file-exec-and-symbols "+data.class);
    });
    
    // -exec-arguments -> Set the inferior program arguments, to be used in the next ‘-exec-run’.
    _command('-exec-arguments', programArgs, function(data) {
      console.log("-exec-arguments "+data.class);
    });
    
    // -target-select -> Connect gdb to the remote target. This command takes two args:
    //   'type' -> The type of target, for instance ‘remote’, etc. 
    //   'parameters' -> Device names, host names and the like. 
    //                   See Commands for Managing Targets, for more details.
    //                   https://sourceware.org/gdb/onlinedocs/gdb/Target-Commands.html
    // The output is a connection notification, followed by the address 
    // at which the target program is, in the following form:
    //   ^connected,addr="address",func="function name",args=[arg list]
    _command('-target-select', ['remote', comm], callback);
    
  };
  
  gdb.prototype.run = 
  gdb.prototype.continue = function(callback) {
    // make sure we have started debugging something and we are on pause (status 'stopped')
    if (me.debuggerState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    
    // exec-continue -> Resumes the execution of the inferior program, which will continue to execute 
    // until it reaches a debugger stop event. If the ‘--reverse’ option is specified, execution resumes 
    // in reverse until it reaches a stop event. Stop events may include
    //   breakpoints or watchpoints
    //   signals or exceptions
    //   the end of the process (or its beginning under ‘--reverse’)
    //   the end or beginning of a replay log if one is being used.
    // In all-stop mode (see All-Stop Mode), may resume only one thread, or all threads, 
    // depending on the value of the ‘scheduler-locking’ variable. If ‘--all’ is specified, 
    // all threads (in all inferiors) will be resumed. The ‘--all’ option is ignored in all-stop mode. 
    // If the ‘--thread-group’ options is specified, then all threads in that thread group are resumed.
    _command("-exec-continue", ['--all'], callback);
  };
  
  gdb.prototype.pause = function(callback) {
    // make sure we have started debugging something and we are 'running'
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    
    // -exec-interrupt -> Interrupts the background execution of the target. 
    // Note how the token associated with the stop message is the one for the execution command that has been interrupted. 
    // The token for the interrupt itself only appears in the ‘^done’ output. 
    // If the user is trying to interrupt a non-running program, an error message will be printed.
    // 
    // Note that when asynchronous execution is enabled, this command is asynchronous just like other execution commands. 
    // That is, first the ‘^done’ response will be printed, and the target stop will be reported after that using the ‘*stopped’ notification.
    // 
    // In non-stop mode, only the context thread is interrupted by default. 
    // All threads (in all inferiors) will be interrupted if the ‘--all’ option is specified. 
    // If the ‘--thread-group’ option is specified, all threads in that group will be interrupted.
    _command("-exec-interrupt", ['--all'], callback);
  };
  
  gdb.prototype.stop = function(callback) {
    // if not running, u r stupid
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    
    // -gdb-exit -> Exit gdb immediately.
    _command("-gdb-exit", [], callback);
  };
  
  
  
  
  //-------------------------------------------------------------------------
  // Step methods
  //-------------------------------------------------------------------------
  gdb.prototype.stepOver = function(args, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot step over' });
      return;
    }
    // -exec-next -> Asynchronous command. Resumes execution of the inferior program, 
    // stopping when the beginning of the next source line is reached.
    _command("-exec-next", args, callback);
  };
  
  gdb.prototype.stepInto = function(args, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot step into' });
      return;
    }
    // -exec-step -> Asynchronous command. Resumes execution of the inferior program, 
    // stopping when the beginning of the next source line is reached, 
    // if the next source line is not a function call. 
    // If it is, stop at the first instruction of the called function
    _command("-exec-step", args, callback);
  };
  
  gdb.prototype.stepOut = function(args, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot step out' });
      return;
    }
    // -exec-finish -> Asynchronous command. Resumes the execution of the inferior program 
    // until the current function is exited. 
    // Displays the results returned by the function
    _command("-exec-finish", args, callback);
  };
  
  
  //-------------------------------------------------------------------------
  // 
  // Query methods
  // 
  //-------------------------------------------------------------------------
  
  gdb.prototype.evalExpression = function(expr, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot eval expression' });
      return;
    }
    
    // -data-evaluate-expression -> Evaluate expr as an expression. The expression 
    // could contain an inferior function call. The function call will execute synchronously. 
    // If the expression contains spaces, it must be enclosed in double quotes.
    _command("-data-evaluate-expression", [expr], callback);
  };
  
  gdb.prototype.setVariableValue = function(varName, varValue, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot set variable value' });
      return;
    }
    
    // https://sourceware.org/gdb/current/onlinedocs/gdb/Assignment.html
    // To alter the value of a variable, evaluate an assignment expression
    _command("-data-evaluate-expression", [varName+"="+varValue], callback);
  };
  
  
  //-------------------------------------------------------------------------
  // 
  // Breakpoint methods
  // 
  //-------------------------------------------------------------------------
  
  gdb.prototype.insertBreakpoint = function(args, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    // -break-insert -> inserts a breakpoint
    _command("-break-insert", args, callback);
  };
  gdb.prototype.enableBreakpoints = function(breakpoints, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    // -break-enable -> Enable (previously disabled) breakpoint(s)
    _command("-break-enable", breakpoints, callback);
  };
  
  gdb.prototype.deleteBreakpoints = function(breakpoints, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    // -break-delete -> Delete the breakpoint(s) whose number(s) are specified in the argument list. 
    // This is obviously reflected in the breakpoint list.
    _command("-break-delete", breakpoints, callback);
  };
  gdb.prototype.disableBreakpoints = function(breakpoints, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    // -break-disable -> Disable the named breakpoint(s). 
    // The field `enabled' in the break list is now set to `n' for the named breakpoint(s).
    _command("-break-disable", breakpoints, callback);
  };
  gdb.prototype.listBreakpoints = function(callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    // -break-list -> Displays the list of inserted breakpoints
    _command("-break-list", [], callback);
  };
  
  
  
  // set args = ["2"] to get more data
  // use the --frame option to select frame --frame 0
  gdb.prototype.listVariables = function(args, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot list variables' });
      return;
    }
    // -stack-list-variables -> Display the names of local variables and function arguments for the 
    // selected frame. If print-values is 0 or --no-values, print only the names of the variables; if it 
    // is 1 or --all-values, print also their values; and if it is 2 or --simple-values, print the name, 
    // type and value for simple data types, and the name and type for arrays, structures and unions. 
    _command("-stack-list-variables", args, callback);
  };
  
  gdb.prototype.callStack = function(args, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot get call stack' });
      return;
    }
    // -stack-list-frames -> List the frames currently on the stack
    _command("-stack-list-frames", args, callback);
  };
  
  gdb.prototype.selectedFrameInfo = function(callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot get info about selected frame' });
      return;
    }
    // -stack-info-frame -> Get info on the selected frame
    _command("-stack-info-frame", [], callback);
  };
  
  gdb.prototype.setSelectedFrame = function(framenum, callback) {
    // error check
    if (me.debugState=='idle') {
      callback({ error: 'Not debugging a program' });
      return;
    }
    if (me.executionState=='running') {
      callback({ error: 'Program is running, cannot set selected frame' });
      return;
    }
    // -stack-select-frame -> Change the selected frame. Select a different frame framenum on the stack
    _command("-stack-select-frame", [framenum], callback);
  };
  
}

module.exports = gdb;

