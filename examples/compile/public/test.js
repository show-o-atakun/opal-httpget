(function(global_object) {
  "use strict";

  // @note
  //   A few conventions for the documentation of this file:
  //   1. Always use "//" (in contrast with "/**/")
  //   2. The syntax used is Yardoc (yardoc.org), which is intended for Ruby (se below)
  //   3. `@param` and `@return` types should be preceded by `JS.` when referring to
  //      JavaScript constructors (e.g. `JS.Function`) otherwise Ruby is assumed.
  //   4. `nil` and `null` being unambiguous refer to the respective
  //      objects/values in Ruby and JavaScript
  //   5. This is still WIP :) so please give feedback and suggestions on how
  //      to improve or for alternative solutions
  //
  //   The way the code is digested before going through Yardoc is a secret kept
  //   in the docs repo (https://github.com/opal/docs/tree/master).

  var console;

  // Detect the global object
  if (typeof(globalThis) !== 'undefined') { global_object = globalThis; }
  else if (typeof(global) !== 'undefined') { global_object = global; }
  else if (typeof(window) !== 'undefined') { global_object = window; }

  // Setup a dummy console object if missing
  if (typeof(global_object.console) === 'object') {
    console = global_object.console;
  } else if (global_object.console == null) {
    console = global_object.console = {};
  } else {
    console = {};
  }

  if (!('log' in console)) { console.log = function () {}; }
  if (!('warn' in console)) { console.warn = console.log; }

  if (typeof(global_object.Opal) !== 'undefined') {
    console.warn('Opal already loaded. Loading twice can cause troubles, please fix your setup.');
    return global_object.Opal;
  }

  var nil;

  // The actual class for BasicObject
  var BasicObject;

  // The actual Object class.
  // The leading underscore is to avoid confusion with window.Object()
  var _Object;

  // The actual Module class
  var Module;

  // The actual Class class
  var Class;

  // The Opal.Opal class (helpers etc.)
  var _Opal;

  // The Kernel module
  var Kernel;

  // The Opal object that is exposed globally
  var Opal = global_object.Opal = {};

  // This is a useful reference to global object inside ruby files
  Opal.global = global_object;
  global_object.Opal = Opal;

  // Configure runtime behavior with regards to require and unsupported features
  Opal.config = {
    missing_require_severity: 'error',        // error, warning, ignore
    unsupported_features_severity: 'warning', // error, warning, ignore
    experimental_features_severity: 'warning',// warning, ignore
    enable_stack_trace: true                  // true, false
  };

  // Minify common function calls
  var $has_own   = Object.hasOwnProperty;
  var $bind      = Function.prototype.bind;
  var $set_proto = Object.setPrototypeOf;
  var $slice     = Array.prototype.slice;
  var $splice    = Array.prototype.splice;

  // Nil object id is always 4
  var nil_id = 4;

  // Generates even sequential numbers greater than 4
  // (nil_id) to serve as unique ids for ruby objects
  var unique_id = nil_id;

  // Return next unique id
  Opal.uid = function() {
    unique_id += 2;
    return unique_id;
  };

  // Retrieve or assign the id of an object
  Opal.id = function(obj) {
    if (obj.$$is_number) return (obj * 2)+1;
    if (obj.$$id != null) {
      return obj.$$id;
    }
    $prop(obj, '$$id', Opal.uid());
    return obj.$$id;
  };

  // Globals table
  Opal.gvars = {};

  // Exit function, this should be replaced by platform specific implementation
  // (See nodejs and chrome for examples)
  Opal.exit = function(status) { if (Opal.gvars.DEBUG) console.log('Exited with status '+status); };

  // keeps track of exceptions for $!
  Opal.exceptions = [];

  // @private
  // Pops an exception from the stack and updates `$!`.
  Opal.pop_exception = function() {
    var exception = Opal.exceptions.pop();
    if (exception) {
      Opal.gvars["!"] = exception;
      Opal.gvars["@"] = exception.$backtrace();
    }
    else {
      Opal.gvars["!"] = Opal.gvars["@"] = nil;
    }
  };

  function $prop(object, name, initialValue) {
    if (typeof(object) === "string") {
      // Special case for:
      //   s = "string"
      //   def s.m; end
      // String class is the only class that:
      // + compiles to JS primitive
      // + allows method definition directly on instances
      // numbers, true, false and null do not support it.
      object[name] = initialValue;
    } else {
      Object.defineProperty(object, name, {
        value: initialValue,
        enumerable: false,
        configurable: true,
        writable: true
      });
    }
  }

  Opal.prop = $prop;

  // @deprecated
  Opal.defineProperty = Opal.prop;

  Opal.slice = $slice;


  // Helpers
  // -----

  var $truthy = Opal.truthy = function(val) {
    return false !== val && nil !== val && undefined !== val && null !== val && (!(val instanceof Boolean) || true === val.valueOf());
  };

  Opal.falsy = function(val) {
    return !$truthy(val);
  };

  Opal.type_error = function(object, type, method, coerced) {
    object = object.$$class;

    if (coerced && method) {
      coerced = coerced.$$class;
      return Opal.TypeError.$new(
        "can't convert " + object + " into " + type +
        " (" + object + "#" + method + " gives " + coerced + ")"
      )
    } else {
      return Opal.TypeError.$new(
        "no implicit conversion of " + object + " into " + type
      )
    }
  };

  Opal.coerce_to = function(object, type, method, args) {
    var body;

    if (method === 'to_int' && type === Opal.Integer && object.$$is_number)
      return object < 0 ? Math.ceil(object) : Math.floor(object);

    if (method === 'to_str' && type === Opal.String && object.$$is_string)
      return object;

    if (Opal.is_a(object, type)) return object;

    // Fast path for the most common situation
    if (object['$respond_to?'].$$pristine && object.$method_missing.$$pristine) {
      body = object['$' + method];
      if (body == null || body.$$stub) throw Opal.type_error(object, type);
      return body.apply(object, args);
    }

    if (!object['$respond_to?'](method)) {
      throw Opal.type_error(object, type);
    }

    if (args == null) args = [];
    return Opal.send(object, method, args);
  }

  Opal.respond_to = function(obj, jsid, include_all) {
    if (obj == null || !obj.$$class) return false;
    include_all = !!include_all;
    var body = obj[jsid];

    if (obj['$respond_to?'].$$pristine) {
      if (typeof(body) === "function" && !body.$$stub) {
        return true;
      }
      if (!obj['$respond_to_missing?'].$$pristine) {
        return Opal.send(obj, obj['$respond_to_missing?'], [jsid.substr(1), include_all]);
      }
    } else {
      return Opal.send(obj, obj['$respond_to?'], [jsid.substr(1), include_all]);
    }
  }

  // TracePoint support
  // ------------------
  //
  // Support for `TracePoint.trace(:class) do ... end`
  Opal.trace_class = false;
  Opal.tracers_for_class = [];

  function invoke_tracers_for_class(klass_or_module) {
    var i, ii, tracer;

    for(i = 0, ii = Opal.tracers_for_class.length; i < ii; i++) {
      tracer = Opal.tracers_for_class[i];
      tracer.trace_object = klass_or_module;
      tracer.block.$call(tracer);
    }
  }

  function handle_autoload(cref, name) {
    if (!cref.$$autoload[name].loaded) {
      cref.$$autoload[name].loaded = true;
      try {
        Opal.Kernel.$require(cref.$$autoload[name].path);
      } catch (e) {
        cref.$$autoload[name].exception = e;
        throw e;
      }
      cref.$$autoload[name].required = true;
      if (cref.$$const[name] != null) {
        cref.$$autoload[name].success = true;
        return cref.$$const[name];
      }
    } else if (cref.$$autoload[name].loaded && !cref.$$autoload[name].required) {
      if (cref.$$autoload[name].exception) { throw cref.$$autoload[name].exception; }
    }
  }

  // Constants
  // ---------
  //
  // For future reference:
  // - The Rails autoloading guide (http://guides.rubyonrails.org/v5.0/autoloading_and_reloading_constants.html)
  // - @ConradIrwin's 2012 post on “Everything you ever wanted to know about constant lookup in Ruby” (http://cirw.in/blog/constant-lookup.html)
  //
  // Legend of MRI concepts/names:
  // - constant reference (cref): the module/class that acts as a namespace
  // - nesting: the namespaces wrapping the current scope, e.g. nesting inside
  //            `module A; module B::C; end; end` is `[B::C, A]`

  // Get the constant in the scope of the current cref
  function const_get_name(cref, name) {
    if (cref) {
      if (cref.$$const[name] != null) { return cref.$$const[name]; }
      if (cref.$$autoload && cref.$$autoload[name]) {
        return handle_autoload(cref, name);
      }
    }
  }

  // Walk up the nesting array looking for the constant
  function const_lookup_nesting(nesting, name) {
    var i, ii, constant;

    if (nesting.length === 0) return;

    // If the nesting is not empty the constant is looked up in its elements
    // and in order. The ancestors of those elements are ignored.
    for (i = 0, ii = nesting.length; i < ii; i++) {
      constant = nesting[i].$$const[name];
      if (constant != null) {
        return constant;
      } else if (nesting[i].$$autoload && nesting[i].$$autoload[name]) {
        return handle_autoload(nesting[i], name);
      }
    }
  }

  // Walk up the ancestors chain looking for the constant
  function const_lookup_ancestors(cref, name) {
    var i, ii, ancestors;

    if (cref == null) return;

    ancestors = Opal.ancestors(cref);

    for (i = 0, ii = ancestors.length; i < ii; i++) {
      if (ancestors[i].$$const && $has_own.call(ancestors[i].$$const, name)) {
        return ancestors[i].$$const[name];
      } else if (ancestors[i].$$autoload && ancestors[i].$$autoload[name]) {
        return handle_autoload(ancestors[i], name);
      }
    }
  }

  // Walk up Object's ancestors chain looking for the constant,
  // but only if cref is missing or a module.
  function const_lookup_Object(cref, name) {
    if (cref == null || cref.$$is_module) {
      return const_lookup_ancestors(_Object, name);
    }
  }

  // Call const_missing if nothing else worked
  function const_missing(cref, name, skip_missing) {
    if (!skip_missing) {
      return (cref || _Object).$const_missing(name);
    }
  }

  // Look for the constant just in the current cref or call `#const_missing`
  Opal.const_get_local = function(cref, name, skip_missing) {
    var result;

    if (cref == null) return;

    if (cref === '::') cref = _Object;

    if (!cref.$$is_module && !cref.$$is_class) {
      throw new Opal.TypeError(cref.toString() + " is not a class/module");
    }

    result = const_get_name(cref, name);              if (result != null) return result;
    result = const_missing(cref, name, skip_missing); if (result != null) return result;
  };

  // Look for the constant relative to a cref or call `#const_missing` (when the
  // constant is prefixed by `::`).
  Opal.const_get_qualified = function(cref, name, skip_missing) {
    var result, cache, cached, current_version = Opal.const_cache_version;

    if (name == null) {
      // A shortpath for calls like ::String => $$$("String")
      result = const_get_name(_Object, cref);

      if (result != null) return result;
      return Opal.const_get_qualified(_Object, cref, skip_missing);
    }

    if (cref == null) return;

    if (cref === '::') cref = _Object;

    if (!cref.$$is_module && !cref.$$is_class) {
      throw new Opal.TypeError(cref.toString() + " is not a class/module");
    }

    if ((cache = cref.$$const_cache) == null) {
      $prop(cref, '$$const_cache', Object.create(null));
      cache = cref.$$const_cache;
    }
    cached = cache[name];

    if (cached == null || cached[0] !== current_version) {
      ((result = const_get_name(cref, name))              != null) ||
      ((result = const_lookup_ancestors(cref, name))      != null);
      cache[name] = [current_version, result];
    } else {
      result = cached[1];
    }

    return result != null ? result : const_missing(cref, name, skip_missing);
  };

  // Initialize the top level constant cache generation counter
  Opal.const_cache_version = 1;

  // Look for the constant in the open using the current nesting and the nearest
  // cref ancestors or call `#const_missing` (when the constant has no :: prefix).
  Opal.const_get_relative = function(nesting, name, skip_missing) {
    var cref = nesting[0], result, current_version = Opal.const_cache_version, cache, cached;

    if ((cache = nesting.$$const_cache) == null) {
      $prop(nesting, '$$const_cache', Object.create(null));
      cache = nesting.$$const_cache;
    }
    cached = cache[name];

    if (cached == null || cached[0] !== current_version) {
      ((result = const_get_name(cref, name))              != null) ||
      ((result = const_lookup_nesting(nesting, name))     != null) ||
      ((result = const_lookup_ancestors(cref, name))      != null) ||
      ((result = const_lookup_Object(cref, name))         != null);

      cache[name] = [current_version, result];
    } else {
      result = cached[1];
    }

    return result != null ? result : const_missing(cref, name, skip_missing);
  };

  // Register the constant on a cref and opportunistically set the name of
  // unnamed classes/modules.
  function $const_set(cref, name, value) {
    if (cref == null || cref === '::') cref = _Object;

    if (value.$$is_a_module) {
      if (value.$$name == null || value.$$name === nil) value.$$name = name;
      if (value.$$base_module == null) value.$$base_module = cref;
    }

    cref.$$const = (cref.$$const || Object.create(null));
    cref.$$const[name] = value;

    // Add a short helper to navigate constants manually.
    // @example
    //   Opal.$$.Regexp.$$.IGNORECASE
    cref.$$ = cref.$$const;

    Opal.const_cache_version++;

    // Expose top level constants onto the Opal object
    if (cref === _Object) Opal[name] = value;

    // Name new class directly onto current scope (Opal.Foo.Baz = klass)
    $prop(cref, name, value);

    return value;
  };

  Opal.const_set = $const_set;

  // Get all the constants reachable from a given cref, by default will include
  // inherited constants.
  Opal.constants = function(cref, inherit) {
    if (inherit == null) inherit = true;

    var module, modules = [cref], i, ii, constants = {}, constant;

    if (inherit) modules = modules.concat(Opal.ancestors(cref));
    if (inherit && cref.$$is_module) modules = modules.concat([Opal.Object]).concat(Opal.ancestors(Opal.Object));

    for (i = 0, ii = modules.length; i < ii; i++) {
      module = modules[i];

      // Do not show Objects constants unless we're querying Object itself
      if (cref !== _Object && module == _Object) break;

      for (constant in module.$$const) {
        constants[constant] = true;
      }
      if (module.$$autoload) {
        for (constant in module.$$autoload) {
          constants[constant] = true;
        }
      }
    }

    return Object.keys(constants);
  };

  // Remove a constant from a cref.
  Opal.const_remove = function(cref, name) {
    Opal.const_cache_version++;

    if (cref.$$const[name] != null) {
      var old = cref.$$const[name];
      delete cref.$$const[name];
      return old;
    }

    if (cref.$$autoload && cref.$$autoload[name]) {
      delete cref.$$autoload[name];
      return nil;
    }

    throw Opal.NameError.$new("constant "+cref+"::"+cref.$name()+" not defined");
  };

  // Generates a function that is a curried const_get_relative.
  Opal.const_get_relative_factory = function(nesting) {
    return function(name, skip_missing) {
      return Opal.$$(nesting, name, skip_missing);
    }
  }

  // Setup some shortcuts to reduce compiled size
  Opal.$$ = Opal.const_get_relative;
  Opal.$$$ = Opal.const_get_qualified;
  Opal.$r = Opal.const_get_relative_factory;

  // Modules & Classes
  // -----------------

  // A `class Foo; end` expression in ruby is compiled to call this runtime
  // method which either returns an existing class of the given name, or creates
  // a new class in the given `base` scope.
  //
  // If a constant with the given name exists, then we check to make sure that
  // it is a class and also that the superclasses match. If either of these
  // fail, then we raise a `TypeError`. Note, `superclass` may be null if one
  // was not specified in the ruby code.
  //
  // We pass a constructor to this method of the form `function ClassName() {}`
  // simply so that classes show up with nicely formatted names inside debuggers
  // in the web browser (or node/sprockets).
  //
  // The `scope` is the current `self` value where the class is being created
  // from. We use this to get the scope for where the class should be created.
  // If `scope` is an object (not a class/module), we simple get its class and
  // use that as the scope instead.
  //
  // @param scope        [Object] where the class is being created
  // @param superclass   [Class,null] superclass of the new class (may be null)
  // @param singleton    [Boolean,null] a true value denotes we want to allocate
  //                                    a singleton
  //
  // @return new [Class]  or existing ruby class
  //
  Opal.allocate_class = function(name, superclass, singleton) {
    var klass, constructor;

    if (superclass != null && superclass.$$bridge) {
      // Inheritance from bridged classes requires
      // calling original JS constructors
      constructor = function() {
        var args = $slice.call(arguments),
            self = new ($bind.apply(superclass.$$constructor, [null].concat(args)))();

        // and replacing a __proto__ manually
        $set_proto(self, klass.$$prototype);
        return self;
      }
    } else {
      constructor = function(){};
    }

    if (name && name !== nil) {
      $prop(constructor, 'displayName', '::'+name);
    }

    klass = constructor;

    $prop(klass, '$$name', name);
    $prop(klass, '$$constructor', constructor);
    $prop(klass, '$$prototype', constructor.prototype);
    $prop(klass, '$$const', {});
    $prop(klass, '$$is_class', true);
    $prop(klass, '$$is_a_module', true);
    $prop(klass, '$$super', superclass);
    $prop(klass, '$$cvars', {});
    $prop(klass, '$$own_included_modules', []);
    $prop(klass, '$$own_prepended_modules', []);
    $prop(klass, '$$ancestors', []);
    $prop(klass, '$$ancestors_cache_version', null);
    $prop(klass, '$$subclasses', []);

    $prop(klass.$$prototype, '$$class', klass);

    // By default if there are no singleton class methods
    // __proto__ is Class.prototype
    // Later singleton methods generate a singleton_class
    // and inject it into ancestors chain
    if (Opal.Class) {
      $set_proto(klass, Opal.Class.prototype);
    }

    if (superclass != null) {
      $set_proto(klass.$$prototype, superclass.$$prototype);

      if (singleton !== true) {
        // Let's not forbid GC from cleaning up our
        // subclasses.
        if (typeof WeakRef !== 'undefined') {
          // First, let's clean up our array from empty objects.
          var i, subclass, rebuilt_subclasses = [];
          for (i = 0; i < superclass.$$subclasses.length; i++) {
            subclass = superclass.$$subclasses[i];
            if (subclass.deref() !== undefined) {
              rebuilt_subclasses.push(subclass);
            }
          }
          // Now, let's add our class.
          rebuilt_subclasses.push(new WeakRef(klass));
          superclass.$$subclasses = rebuilt_subclasses;
        }
        else {
          superclass.$$subclasses.push(klass);
        }
      }

      if (superclass.$$meta) {
        // If superclass has metaclass then we have explicitely inherit it.
        Opal.build_class_singleton_class(klass);
      }
    }

    return klass;
  };


  function find_existing_class(scope, name) {
    // Try to find the class in the current scope
    var klass = const_get_name(scope, name);

    // If the class exists in the scope, then we must use that
    if (klass) {
      // Make sure the existing constant is a class, or raise error
      if (!klass.$$is_class) {
        throw Opal.TypeError.$new(name + " is not a class");
      }

      return klass;
    }
  }

  function ensureSuperclassMatch(klass, superclass) {
    if (klass.$$super !== superclass) {
      throw Opal.TypeError.$new("superclass mismatch for class " + klass.$$name);
    }
  }

  Opal.klass = function(scope, superclass, name) {
    var bridged;

    if (scope == null || scope == '::') {
      // Global scope
      scope = _Object;
    } else if (!scope.$$is_class && !scope.$$is_module) {
      // Scope is an object, use its class
      scope = scope.$$class;
    }

    // If the superclass is not an Opal-generated class then we're bridging a native JS class
    if (
      superclass != null && (!superclass.hasOwnProperty || (
        superclass.hasOwnProperty && !superclass.hasOwnProperty('$$is_class')
      ))
    ) {
      if (superclass.constructor && superclass.constructor.name == "Function") {
        bridged = superclass;
        superclass = _Object;
      } else {
        throw Opal.TypeError.$new("superclass must be a Class (" + (
          (superclass.constructor && (superclass.constructor.name || superclass.constructor.$$name)) ||
          typeof(superclass)
        ) + " given)");
      }
    }

    var klass = find_existing_class(scope, name);

    if (klass) {
      if (superclass) {
        // Make sure existing class has same superclass
        ensureSuperclassMatch(klass, superclass);
      }

      if (Opal.trace_class) { invoke_tracers_for_class(klass); }

      return klass;
    }

    // Class doesn't exist, create a new one with given superclass...

    // Not specifying a superclass means we can assume it to be Object
    if (superclass == null) {
      superclass = _Object;
    }

    // Create the class object (instance of Class)
    klass = Opal.allocate_class(name, superclass);
    $const_set(scope, name, klass);

    // Call .inherited() hook with new class on the superclass
    if (superclass.$inherited) {
      superclass.$inherited(klass);
    }

    if (bridged) {
      Opal.bridge(bridged, klass);
    }

    if (Opal.trace_class) { invoke_tracers_for_class(klass); }

    return klass;
  };

  // Define new module (or return existing module). The given `scope` is basically
  // the current `self` value the `module` statement was defined in. If this is
  // a ruby module or class, then it is used, otherwise if the scope is a ruby
  // object then that objects real ruby class is used (e.g. if the scope is the
  // main object, then the top level `Object` class is used as the scope).
  //
  // If a module of the given name is already defined in the scope, then that
  // instance is just returned.
  //
  // If there is a class of the given name in the scope, then an error is
  // generated instead (cannot have a class and module of same name in same scope).
  //
  // Otherwise, a new module is created in the scope with the given name, and that
  // new instance is returned back (to be referenced at runtime).
  //
  // @param  scope [Module, Class] class or module this definition is inside
  // @param  id   [String] the name of the new (or existing) module
  //
  // @return [Module]
  Opal.allocate_module = function(name) {
    var constructor = function(){};
    if (name) {
      $prop(constructor, 'displayName', name+'.$$constructor');
    }

    var module = constructor;

    if (name)
      $prop(constructor, 'displayName', name+'.constructor');

    $prop(module, '$$name', name);
    $prop(module, '$$prototype', constructor.prototype);
    $prop(module, '$$const', {});
    $prop(module, '$$is_module', true);
    $prop(module, '$$is_a_module', true);
    $prop(module, '$$cvars', {});
    $prop(module, '$$iclasses', []);
    $prop(module, '$$own_included_modules', []);
    $prop(module, '$$own_prepended_modules', []);
    $prop(module, '$$ancestors', [module]);
    $prop(module, '$$ancestors_cache_version', null);

    $set_proto(module, Opal.Module.prototype);

    return module;
  };

  function find_existing_module(scope, name) {
    var module = const_get_name(scope, name);
    if (module == null && scope === _Object) module = const_lookup_ancestors(_Object, name);

    if (module) {
      if (!module.$$is_module && module !== _Object) {
        throw Opal.TypeError.$new(name + " is not a module");
      }
    }

    return module;
  }

  Opal.module = function(scope, name) {
    var module;

    if (scope == null || scope == '::') {
      // Global scope
      scope = _Object;
    } else if (!scope.$$is_class && !scope.$$is_module) {
      // Scope is an object, use its class
      scope = scope.$$class;
    }

    module = find_existing_module(scope, name);

    if (module) {

      if (Opal.trace_class) { invoke_tracers_for_class(module); }

      return module;
    }

    // Module doesnt exist, create a new one...
    module = Opal.allocate_module(name);
    $const_set(scope, name, module);

    if (Opal.trace_class) { invoke_tracers_for_class(module); }

    return module;
  };

  // Return the singleton class for the passed object.
  //
  // If the given object alredy has a singleton class, then it will be stored on
  // the object as the `$$meta` property. If this exists, then it is simply
  // returned back.
  //
  // Otherwise, a new singleton object for the class or object is created, set on
  // the object at `$$meta` for future use, and then returned.
  //
  // @param object [Object] the ruby object
  // @return [Class] the singleton class for object
  Opal.get_singleton_class = function(object) {
    if (object.$$meta) {
      return object.$$meta;
    }

    if (object.hasOwnProperty('$$is_class')) {
      return Opal.build_class_singleton_class(object);
    } else if (object.hasOwnProperty('$$is_module')) {
      return Opal.build_module_singleton_class(object);
    } else {
      return Opal.build_object_singleton_class(object);
    }
  };

  // Build the singleton class for an existing class. Class object are built
  // with their singleton class already in the prototype chain and inheriting
  // from their superclass object (up to `Class` itself).
  //
  // NOTE: Actually in MRI a class' singleton class inherits from its
  // superclass' singleton class which in turn inherits from Class.
  //
  // @param klass [Class]
  // @return [Class]
  Opal.build_class_singleton_class = function(klass) {
    var superclass, meta;

    if (klass.$$meta) {
      return klass.$$meta;
    }

    // The singleton_class superclass is the singleton_class of its superclass;
    // but BasicObject has no superclass (its `$$super` is null), thus we
    // fallback on `Class`.
    superclass = klass === BasicObject ? Class : Opal.get_singleton_class(klass.$$super);

    meta = Opal.allocate_class(null, superclass, true);

    $prop(meta, '$$is_singleton', true);
    $prop(meta, '$$singleton_of', klass);
    $prop(klass, '$$meta', meta);
    $set_proto(klass, meta.$$prototype);
    // Restoring ClassName.class
    $prop(klass, '$$class', Opal.Class);

    return meta;
  };

  Opal.build_module_singleton_class = function(mod) {
    if (mod.$$meta) {
      return mod.$$meta;
    }

    var meta = Opal.allocate_class(null, Opal.Module, true);

    $prop(meta, '$$is_singleton', true);
    $prop(meta, '$$singleton_of', mod);
    $prop(mod, '$$meta', meta);
    $set_proto(mod, meta.$$prototype);
    // Restoring ModuleName.class
    $prop(mod, '$$class', Opal.Module);

    return meta;
  };

  // Build the singleton class for a Ruby (non class) Object.
  //
  // @param object [Object]
  // @return [Class]
  Opal.build_object_singleton_class = function(object) {
    var superclass = object.$$class,
        klass = Opal.allocate_class(nil, superclass, true);

    $prop(klass, '$$is_singleton', true);
    $prop(klass, '$$singleton_of', object);

    delete klass.$$prototype.$$class;

    $prop(object, '$$meta', klass);

    $set_proto(object, object.$$meta.$$prototype);

    return klass;
  };

  Opal.is_method = function(prop) {
    return (prop[0] === '$' && prop[1] !== '$');
  };

  Opal.instance_methods = function(mod) {
    var exclude = [], results = [], ancestors = Opal.ancestors(mod);

    for (var i = 0, l = ancestors.length; i < l; i++) {
      var ancestor = ancestors[i],
          proto = ancestor.$$prototype;

      if (proto.hasOwnProperty('$$dummy')) {
        proto = proto.$$define_methods_on;
      }

      var props = Object.getOwnPropertyNames(proto);

      for (var j = 0, ll = props.length; j < ll; j++) {
        var prop = props[j];

        if (Opal.is_method(prop)) {
          var method_name = prop.slice(1),
              method = proto[prop];

          if (method.$$stub && exclude.indexOf(method_name) === -1) {
            exclude.push(method_name);
          }

          if (!method.$$stub && results.indexOf(method_name) === -1 && exclude.indexOf(method_name) === -1) {
            results.push(method_name);
          }
        }
      }
    }

    return results;
  };

  Opal.own_instance_methods = function(mod) {
    var results = [],
        proto = mod.$$prototype;

    if (proto.hasOwnProperty('$$dummy')) {
      proto = proto.$$define_methods_on;
    }

    var props = Object.getOwnPropertyNames(proto);

    for (var i = 0, length = props.length; i < length; i++) {
      var prop = props[i];

      if (Opal.is_method(prop)) {
        var method = proto[prop];

        if (!method.$$stub) {
          var method_name = prop.slice(1);
          results.push(method_name);
        }
      }
    }

    return results;
  };

  Opal.methods = function(obj) {
    return Opal.instance_methods(obj.$$meta || obj.$$class);
  };

  Opal.own_methods = function(obj) {
    if (obj.$$meta) {
      return Opal.own_instance_methods(obj.$$meta);
    }
    else {
      return [];
    }
  };

  Opal.receiver_methods = function(obj) {
    var mod = Opal.get_singleton_class(obj);
    var singleton_methods = Opal.own_instance_methods(mod);
    var instance_methods = Opal.own_instance_methods(mod.$$super);
    return singleton_methods.concat(instance_methods);
  };

  // Returns an object containing all pairs of names/values
  // for all class variables defined in provided +module+
  // and its ancestors.
  //
  // @param module [Module]
  // @return [Object]
  Opal.class_variables = function(module) {
    var ancestors = Opal.ancestors(module),
        i, length = ancestors.length,
        result = {};

    for (i = length - 1; i >= 0; i--) {
      var ancestor = ancestors[i];

      for (var cvar in ancestor.$$cvars) {
        result[cvar] = ancestor.$$cvars[cvar];
      }
    }

    return result;
  };

  // Sets class variable with specified +name+ to +value+
  // in provided +module+
  //
  // @param module [Module]
  // @param name [String]
  // @param value [Object]
  Opal.class_variable_set = function(module, name, value) {
    var ancestors = Opal.ancestors(module),
        i, length = ancestors.length;

    for (i = length - 2; i >= 0; i--) {
      var ancestor = ancestors[i];

      if ($has_own.call(ancestor.$$cvars, name)) {
        ancestor.$$cvars[name] = value;
        return value;
      }
    }

    module.$$cvars[name] = value;

    return value;
  };

  // Gets class variable with specified +name+ from provided +module+
  //
  // @param module [Module]
  // @param name [String]
  Opal.class_variable_get = function(module, name, tolerant) {
    if ($has_own.call(module.$$cvars, name))
      return module.$$cvars[name];

    var ancestors = Opal.ancestors(module),
      i, length = ancestors.length;

    for (i = 0; i < length; i++) {
      var ancestor = ancestors[i];

      if ($has_own.call(ancestor.$$cvars, name)) {
        return ancestor.$$cvars[name];
      }
    }

    if (!tolerant)
      throw Opal.NameError.$new('uninitialized class variable '+name+' in '+module.$name());

    return nil;
  }

  function isRoot(proto) {
    return proto.hasOwnProperty('$$iclass') && proto.hasOwnProperty('$$root');
  }

  function own_included_modules(module) {
    var result = [], mod, proto = Object.getPrototypeOf(module.$$prototype);

    while (proto) {
      if (proto.hasOwnProperty('$$class')) {
        // superclass
        break;
      }
      mod = protoToModule(proto);
      if (mod) {
        result.push(mod);
      }
      proto = Object.getPrototypeOf(proto);
    }

    return result;
  }

  function own_prepended_modules(module) {
    var result = [], mod, proto = Object.getPrototypeOf(module.$$prototype);

    if (module.$$prototype.hasOwnProperty('$$dummy')) {
      while (proto) {
        if (proto === module.$$prototype.$$define_methods_on) {
          break;
        }

        mod = protoToModule(proto);
        if (mod) {
          result.push(mod);
        }

        proto = Object.getPrototypeOf(proto);
      }
    }

    return result;
  }


  // The actual inclusion of a module into a class.
  //
  // ## Class `$$parent` and `iclass`
  //
  // To handle `super` calls, every class has a `$$parent`. This parent is
  // used to resolve the next class for a super call. A normal class would
  // have this point to its superclass. However, if a class includes a module
  // then this would need to take into account the module. The module would
  // also have to then point its `$$parent` to the actual superclass. We
  // cannot modify modules like this, because it might be included in more
  // then one class. To fix this, we actually insert an `iclass` as the class'
  // `$$parent` which can then point to the superclass. The `iclass` acts as
  // a proxy to the actual module, so the `super` chain can then search it for
  // the required method.
  //
  // @param module [Module] the module to include
  // @param includer [Module] the target class to include module into
  // @return [null]
  Opal.append_features = function(module, includer) {
    var module_ancestors = Opal.ancestors(module);
    var iclasses = [];

    if (module_ancestors.indexOf(includer) !== -1) {
      throw Opal.ArgumentError.$new('cyclic include detected');
    }

    for (var i = 0, length = module_ancestors.length; i < length; i++) {
      var ancestor = module_ancestors[i], iclass = create_iclass(ancestor);
      $prop(iclass, '$$included', true);
      iclasses.push(iclass);
    }
    var includer_ancestors = Opal.ancestors(includer),
        chain = chain_iclasses(iclasses),
        start_chain_after,
        end_chain_on;

    if (includer_ancestors.indexOf(module) === -1) {
      // first time include

      // includer -> chain.first -> ...chain... -> chain.last -> includer.parent
      start_chain_after = includer.$$prototype;
      end_chain_on = Object.getPrototypeOf(includer.$$prototype);
    } else {
      // The module has been already included,
      // we don't need to put it into the ancestors chain again,
      // but this module may have new included modules.
      // If it's true we need to copy them.
      //
      // The simplest way is to replace ancestors chain from
      //          parent
      //            |
      //   `module` iclass (has a $$root flag)
      //            |
      //   ...previos chain of module.included_modules ...
      //            |
      //  "next ancestor" (has a $$root flag or is a real class)
      //
      // to
      //          parent
      //            |
      //    `module` iclass (has a $$root flag)
      //            |
      //   ...regenerated chain of module.included_modules
      //            |
      //   "next ancestor" (has a $$root flag or is a real class)
      //
      // because there are no intermediate classes between `parent` and `next ancestor`.
      // It doesn't break any prototypes of other objects as we don't change class references.

      var parent = includer.$$prototype, module_iclass = Object.getPrototypeOf(parent);

      while (module_iclass != null) {
        if (module_iclass.$$module === module && isRoot(module_iclass)) {
          break;
        }

        parent = module_iclass;
        module_iclass = Object.getPrototypeOf(module_iclass);
      }

      if (module_iclass) {
        // module has been directly included
        var next_ancestor = Object.getPrototypeOf(module_iclass);

        // skip non-root iclasses (that were recursively included)
        while (next_ancestor.hasOwnProperty('$$iclass') && !isRoot(next_ancestor)) {
          next_ancestor = Object.getPrototypeOf(next_ancestor);
        }

        start_chain_after = parent;
        end_chain_on = next_ancestor;
      } else {
        // module has not been directly included but was in ancestor chain because it was included by another module
        // include it directly
        start_chain_after = includer.$$prototype;
        end_chain_on = Object.getPrototypeOf(includer.$$prototype);
      }
    }

    $set_proto(start_chain_after, chain.first);
    $set_proto(chain.last, end_chain_on);

    // recalculate own_included_modules cache
    includer.$$own_included_modules = own_included_modules(includer);

    Opal.const_cache_version++;
  };

  Opal.prepend_features = function(module, prepender) {
    // Here we change the ancestors chain from
    //
    //   prepender
    //      |
    //    parent
    //
    // to:
    //
    // dummy(prepender)
    //      |
    //  iclass(module)
    //      |
    // iclass(prepender)
    //      |
    //    parent
    var module_ancestors = Opal.ancestors(module);
    var iclasses = [];

    if (module_ancestors.indexOf(prepender) !== -1) {
      throw Opal.ArgumentError.$new('cyclic prepend detected');
    }

    for (var i = 0, length = module_ancestors.length; i < length; i++) {
      var ancestor = module_ancestors[i], iclass = create_iclass(ancestor);
      $prop(iclass, '$$prepended', true);
      iclasses.push(iclass);
    }

    var chain = chain_iclasses(iclasses),
        dummy_prepender = prepender.$$prototype,
        previous_parent = Object.getPrototypeOf(dummy_prepender),
        prepender_iclass,
        start_chain_after,
        end_chain_on;

    if (dummy_prepender.hasOwnProperty('$$dummy')) {
      // The module already has some prepended modules
      // which means that we don't need to make it "dummy"
      prepender_iclass = dummy_prepender.$$define_methods_on;
    } else {
      // Making the module "dummy"
      prepender_iclass = create_dummy_iclass(prepender);
      flush_methods_in(prepender);
      $prop(dummy_prepender, '$$dummy', true);
      $prop(dummy_prepender, '$$define_methods_on', prepender_iclass);

      // Converting
      //   dummy(prepender) -> previous_parent
      // to
      //   dummy(prepender) -> iclass(prepender) -> previous_parent
      $set_proto(dummy_prepender, prepender_iclass);
      $set_proto(prepender_iclass, previous_parent);
    }

    var prepender_ancestors = Opal.ancestors(prepender);

    if (prepender_ancestors.indexOf(module) === -1) {
      // first time prepend

      start_chain_after = dummy_prepender;

      // next $$root or prepender_iclass or non-$$iclass
      end_chain_on = Object.getPrototypeOf(dummy_prepender);
      while (end_chain_on != null) {
        if (
          end_chain_on.hasOwnProperty('$$root') ||
          end_chain_on === prepender_iclass ||
          !end_chain_on.hasOwnProperty('$$iclass')
        ) {
          break;
        }

        end_chain_on = Object.getPrototypeOf(end_chain_on);
      }
    } else {
      throw Opal.RuntimeError.$new("Prepending a module multiple times is not supported");
    }

    $set_proto(start_chain_after, chain.first);
    $set_proto(chain.last, end_chain_on);

    // recalculate own_prepended_modules cache
    prepender.$$own_prepended_modules = own_prepended_modules(prepender);

    Opal.const_cache_version++;
  };

  function flush_methods_in(module) {
    var proto = module.$$prototype,
        props = Object.getOwnPropertyNames(proto);

    for (var i = 0; i < props.length; i++) {
      var prop = props[i];
      if (Opal.is_method(prop)) {
        delete proto[prop];
      }
    }
  }

  function create_iclass(module) {
    var iclass = create_dummy_iclass(module);

    if (module.$$is_module) {
      module.$$iclasses.push(iclass);
    }

    return iclass;
  }

  // Dummy iclass doesn't receive updates when the module gets a new method.
  function create_dummy_iclass(module) {
    var iclass = {},
        proto = module.$$prototype;

    if (proto.hasOwnProperty('$$dummy')) {
      proto = proto.$$define_methods_on;
    }

    var props = Object.getOwnPropertyNames(proto),
        length = props.length, i;

    for (i = 0; i < length; i++) {
      var prop = props[i];
      $prop(iclass, prop, proto[prop]);
    }

    $prop(iclass, '$$iclass', true);
    $prop(iclass, '$$module', module);

    return iclass;
  }

  function chain_iclasses(iclasses) {
    var length = iclasses.length, first = iclasses[0];

    $prop(first, '$$root', true);

    if (length === 1) {
      return { first: first, last: first };
    }

    var previous = first;

    for (var i = 1; i < length; i++) {
      var current = iclasses[i];
      $set_proto(previous, current);
      previous = current;
    }


    return { first: iclasses[0], last: iclasses[length - 1] };
  }

  // For performance, some core Ruby classes are toll-free bridged to their
  // native JavaScript counterparts (e.g. a Ruby Array is a JavaScript Array).
  //
  // This method is used to setup a native constructor (e.g. Array), to have
  // its prototype act like a normal Ruby class. Firstly, a new Ruby class is
  // created using the native constructor so that its prototype is set as the
  // target for the new class. Note: all bridged classes are set to inherit
  // from Object.
  //
  // Example:
  //
  //    Opal.bridge(self, Function);
  //
  // @param klass       [Class] the Ruby class to bridge
  // @param constructor [JS.Function] native JavaScript constructor to use
  // @return [Class] returns the passed Ruby class
  //
  Opal.bridge = function(native_klass, klass) {
    if (native_klass.hasOwnProperty('$$bridge')) {
      throw Opal.ArgumentError.$new("already bridged");
    }

    // constructor is a JS function with a prototype chain like:
    // - constructor
    //   - super
    //
    // What we need to do is to inject our class (with its prototype chain)
    // between constructor and super. For example, after injecting ::Object
    // into JS String we get:
    //
    // - constructor (window.String)
    //   - Opal.Object
    //     - Opal.Kernel
    //       - Opal.BasicObject
    //         - super (window.Object)
    //           - null
    //
    $prop(native_klass, '$$bridge', klass);
    $set_proto(native_klass.prototype, (klass.$$super || Opal.Object).$$prototype);
    $prop(klass, '$$prototype', native_klass.prototype);

    $prop(klass.$$prototype, '$$class', klass);
    $prop(klass, '$$constructor', native_klass);
    $prop(klass, '$$bridge', true);
  };

  function protoToModule(proto) {
    if (proto.hasOwnProperty('$$dummy')) {
      return;
    } else if (proto.hasOwnProperty('$$iclass')) {
      return proto.$$module;
    } else if (proto.hasOwnProperty('$$class')) {
      return proto.$$class;
    }
  }

  function own_ancestors(module) {
    return module.$$own_prepended_modules.concat([module]).concat(module.$$own_included_modules);
  }

  // The Array of ancestors for a given module/class
  Opal.ancestors = function(module) {
    if (!module) { return []; }

    if (module.$$ancestors_cache_version === Opal.const_cache_version) {
      return module.$$ancestors;
    }

    var result = [], i, mods, length;

    for (i = 0, mods = own_ancestors(module), length = mods.length; i < length; i++) {
      result.push(mods[i]);
    }

    if (module.$$super) {
      for (i = 0, mods = Opal.ancestors(module.$$super), length = mods.length; i < length; i++) {
        result.push(mods[i]);
      }
    }

    module.$$ancestors_cache_version = Opal.const_cache_version;
    module.$$ancestors = result;

    return result;
  };

  Opal.included_modules = function(module) {
    var result = [], mod = null, proto = Object.getPrototypeOf(module.$$prototype);

    for (; proto && Object.getPrototypeOf(proto); proto = Object.getPrototypeOf(proto)) {
      mod = protoToModule(proto);
      if (mod && mod.$$is_module && proto.$$iclass && proto.$$included) {
        result.push(mod);
      }
    }

    return result;
  };


  // Method Missing
  // --------------

  // Methods stubs are used to facilitate method_missing in opal. A stub is a
  // placeholder function which just calls `method_missing` on the receiver.
  // If no method with the given name is actually defined on an object, then it
  // is obvious to say that the stub will be called instead, and then in turn
  // method_missing will be called.
  //
  // When a file in ruby gets compiled to javascript, it includes a call to
  // this function which adds stubs for every method name in the compiled file.
  // It should then be safe to assume that method_missing will work for any
  // method call detected.
  //
  // Method stubs are added to the BasicObject prototype, which every other
  // ruby object inherits, so all objects should handle method missing. A stub
  // is only added if the given property name (method name) is not already
  // defined.
  //
  // Note: all ruby methods have a `$` prefix in javascript, so all stubs will
  // have this prefix as well (to make this method more performant).
  //
  //    Opal.add_stubs("foo,bar,baz=");
  //
  // All stub functions will have a private `$$stub` property set to true so
  // that other internal methods can detect if a method is just a stub or not.
  // `Kernel#respond_to?` uses this property to detect a methods presence.
  //
  // @param stubs [Array] an array of method stubs to add
  // @return [undefined]
  Opal.add_stubs = function(stubs) {
    var proto = Opal.BasicObject.$$prototype;
    var stub, existing_method;
    stubs = stubs.split(',');

    for (var i = 0, length = stubs.length; i < length; i++) {
      stub = '$'+stubs[i], existing_method = proto[stub];

      if (existing_method == null || existing_method.$$stub) {
        Opal.add_stub_for(proto, stub);
      }
    }
  };

  // Add a method_missing stub function to the given prototype for the
  // given name.
  //
  // @param prototype [Prototype] the target prototype
  // @param stub [String] stub name to add (e.g. "$foo")
  // @return [undefined]
  Opal.add_stub_for = function(prototype, stub) {
    // Opal.stub_for(stub) is the method_missing_stub
    $prop(prototype, stub, Opal.stub_for(stub));
  };

  // Generate the method_missing stub for a given method name.
  //
  // @param method_name [String] The js-name of the method to stub (e.g. "$foo")
  // @return [undefined]
  Opal.stub_for = function(method_name) {

    function method_missing_stub() {
      // Copy any given block onto the method_missing dispatcher
      this.$method_missing.$$p = method_missing_stub.$$p;

      // Set block property to null ready for the next call (stop false-positives)
      delete method_missing_stub.$$p;

      // call method missing with correct args (remove '$' prefix on method name)
      var args_ary = new Array(arguments.length);
      for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = arguments[i]; }

      return this.$method_missing.apply(this, [method_name.slice(1)].concat(args_ary));
    }

    method_missing_stub.$$stub = true;

    return method_missing_stub;
  };


  // Methods
  // -------

  // Arity count error dispatcher for methods
  //
  // @param actual [Fixnum] number of arguments given to method
  // @param expected [Fixnum] expected number of arguments
  // @param object [Object] owner of the method +meth+
  // @param meth [String] method name that got wrong number of arguments
  // @raise [ArgumentError]
  Opal.ac = function(actual, expected, object, meth) {
    var inspect = '';
    if (object.$$is_a_module) {
      inspect += object.$$name + '.';
    }
    else {
      inspect += object.$$class.$$name + '#';
    }
    inspect += meth;

    throw Opal.ArgumentError.$new('[' + inspect + '] wrong number of arguments (given ' + actual + ', expected ' + expected + ')');
  };

  // Arity count error dispatcher for blocks
  //
  // @param actual [Fixnum] number of arguments given to block
  // @param expected [Fixnum] expected number of arguments
  // @param context [Object] context of the block definition
  // @raise [ArgumentError]
  Opal.block_ac = function(actual, expected, context) {
    var inspect = "`block in " + context + "'";

    throw Opal.ArgumentError.$new(inspect + ': wrong number of arguments (given ' + actual + ', expected ' + expected + ')');
  };

  // Super dispatcher
  Opal.find_super = function(obj, mid, current_func, defcheck, allow_stubs) {
    var jsid = '$' + mid, ancestors, super_method;

    if (obj.hasOwnProperty('$$meta')) {
      ancestors = Opal.ancestors(obj.$$meta);
    } else {
      ancestors = Opal.ancestors(obj.$$class);
    }

    var current_index = ancestors.indexOf(current_func.$$owner);

    for (var i = current_index + 1; i < ancestors.length; i++) {
      var ancestor = ancestors[i],
          proto = ancestor.$$prototype;

      if (proto.hasOwnProperty('$$dummy')) {
        proto = proto.$$define_methods_on;
      }

      if (proto.hasOwnProperty(jsid)) {
        super_method = proto[jsid];
        break;
      }
    }

    if (!defcheck && super_method && super_method.$$stub && obj.$method_missing.$$pristine) {
      // method_missing hasn't been explicitly defined
      throw Opal.NoMethodError.$new('super: no superclass method `'+mid+"' for "+obj, mid);
    }

    return (super_method.$$stub && !allow_stubs) ? null : super_method;
  };

  // Iter dispatcher for super in a block
  Opal.find_block_super = function(obj, jsid, current_func, defcheck, implicit) {
    var call_jsid = jsid;

    if (!current_func) {
      throw Opal.RuntimeError.$new("super called outside of method");
    }

    if (implicit && current_func.$$define_meth) {
      throw Opal.RuntimeError.$new(
        "implicit argument passing of super from method defined by define_method() is not supported. " +
        "Specify all arguments explicitly"
      );
    }

    if (current_func.$$def) {
      call_jsid = current_func.$$jsid;
    }

    return Opal.find_super(obj, call_jsid, current_func, defcheck);
  };

  // @deprecated
  Opal.find_super_dispatcher = Opal.find_super;

  // @deprecated
  Opal.find_iter_super_dispatcher = Opal.find_block_super;

  // Used to return as an expression. Sometimes, we can't simply return from
  // a javascript function as if we were a method, as the return is used as
  // an expression, or even inside a block which must "return" to the outer
  // method. This helper simply throws an error which is then caught by the
  // method. This approach is expensive, so it is only used when absolutely
  // needed.
  //
  Opal.ret = function(val) {
    Opal.returner.$v = val;
    throw Opal.returner;
  };

  // Used to break out of a block.
  Opal.brk = function(val, breaker) {
    breaker.$v = val;
    throw breaker;
  };

  // Builds a new unique breaker, this is to avoid multiple nested breaks to get
  // in the way of each other.
  Opal.new_brk = function() {
    return new Error('unexpected break');
  };

  // handles yield calls for 1 yielded arg
  Opal.yield1 = function(block, arg) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    var has_mlhs = block.$$has_top_level_mlhs_arg,
        has_trailing_comma = block.$$has_trailing_comma_in_args;

    if (block.length > 1 || ((has_mlhs || has_trailing_comma) && block.length === 1)) {
      arg = Opal.to_ary(arg);
    }

    if ((block.length > 1 || (has_trailing_comma && block.length === 1)) && arg.$$is_array) {
      return block.apply(null, arg);
    }
    else {
      return block(arg);
    }
  };

  // handles yield for > 1 yielded arg
  Opal.yieldX = function(block, args) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && args.length === 1) {
      if (args[0].$$is_array) {
        return block.apply(null, args[0]);
      }
    }

    if (!args.$$is_array) {
      var args_ary = new Array(args.length);
      for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = args[i]; }

      return block.apply(null, args_ary);
    }

    return block.apply(null, args);
  };

  // Finds the corresponding exception match in candidates.  Each candidate can
  // be a value, or an array of values.  Returns null if not found.
  Opal.rescue = function(exception, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];

      if (candidate.$$is_array) {
        var result = Opal.rescue(exception, candidate);

        if (result) {
          return result;
        }
      }
      else if (candidate === Opal.JS.Error) {
        return candidate;
      }
      else if (candidate['$==='](exception)) {
        return candidate;
      }
    }

    return null;
  };

  Opal.is_a = function(object, klass) {
    if (klass != null && object.$$meta === klass || object.$$class === klass) {
      return true;
    }

    if (object.$$is_number && klass.$$is_number_class) {
      return (klass.$$is_integer_class) ? (object % 1) === 0 : true;
    }

    var ancestors = Opal.ancestors(object.$$is_class ? Opal.get_singleton_class(object) : (object.$$meta || object.$$class));

    return ancestors.indexOf(klass) !== -1;
  };

  // Helpers for extracting kwsplats
  // Used for: { **h }
  Opal.to_hash = function(value) {
    if (value.$$is_hash) {
      return value;
    }
    else if (value['$respond_to?']('to_hash', true)) {
      var hash = value.$to_hash();
      if (hash.$$is_hash) {
        return hash;
      }
      else {
        throw Opal.TypeError.$new("Can't convert " + value.$$class +
          " to Hash (" + value.$$class + "#to_hash gives " + hash.$$class + ")");
      }
    }
    else {
      throw Opal.TypeError.$new("no implicit conversion of " + value.$$class + " into Hash");
    }
  };

  // Helpers for implementing multiple assignment
  // Our code for extracting the values and assigning them only works if the
  // return value is a JS array.
  // So if we get an Array subclass, extract the wrapped JS array from it

  // Used for: a, b = something (no splat)
  Opal.to_ary = function(value) {
    if (value.$$is_array) {
      return value;
    }
    else if (value['$respond_to?']('to_ary', true)) {
      var ary = value.$to_ary();
      if (ary === nil) {
        return [value];
      }
      else if (ary.$$is_array) {
        return ary;
      }
      else {
        throw Opal.TypeError.$new("Can't convert " + value.$$class +
          " to Array (" + value.$$class + "#to_ary gives " + ary.$$class + ")");
      }
    }
    else {
      return [value];
    }
  };

  // Used for: a, b = *something (with splat)
  Opal.to_a = function(value) {
    if (value.$$is_array) {
      // A splatted array must be copied
      return value.slice();
    }
    else if (value['$respond_to?']('to_a', true)) {
      var ary = value.$to_a();
      if (ary === nil) {
        return [value];
      }
      else if (ary.$$is_array) {
        return ary;
      }
      else {
        throw Opal.TypeError.$new("Can't convert " + value.$$class +
          " to Array (" + value.$$class + "#to_a gives " + ary.$$class + ")");
      }
    }
    else {
      return [value];
    }
  };

  // Used for extracting keyword arguments from arguments passed to
  // JS function. If provided +arguments+ list doesn't have a Hash
  // as a last item, returns a blank Hash.
  //
  // @param parameters [Array]
  // @return [Hash]
  //
  Opal.extract_kwargs = function(parameters) {
    var kwargs = parameters[parameters.length - 1];
    if (kwargs != null && Opal.respond_to(kwargs, '$to_hash', true)) {
      $splice.call(parameters, parameters.length - 1);
      return kwargs.$to_hash();
    }
    else {
      return Opal.hash2([], {});
    }
  };

  // Used to get a list of rest keyword arguments. Method takes the given
  // keyword args, i.e. the hash literal passed to the method containing all
  // keyword arguemnts passed to method, as well as the used args which are
  // the names of required and optional arguments defined. This method then
  // just returns all key/value pairs which have not been used, in a new
  // hash literal.
  //
  // @param given_args [Hash] all kwargs given to method
  // @param used_args [Object<String: true>] all keys used as named kwargs
  // @return [Hash]
  //
  Opal.kwrestargs = function(given_args, used_args) {
    var keys      = [],
        map       = {},
        key           ,
        given_map = given_args.$$smap;

    for (key in given_map) {
      if (!used_args[key]) {
        keys.push(key);
        map[key] = given_map[key];
      }
    }

    return Opal.hash2(keys, map);
  };

  function apply_blockopts(block, blockopts) {
    if (typeof(blockopts) === 'number') {
      block.$$arity = blockopts;
    }
    else if (typeof(blockopts) === 'object') {
      Object.assign(block, blockopts);
    }
  }

  // Calls passed method on a ruby object with arguments and block:
  //
  // Can take a method or a method name.
  //
  // 1. When method name gets passed it invokes it by its name
  //    and calls 'method_missing' when object doesn't have this method.
  //    Used internally by Opal to invoke method that takes a block or a splat.
  // 2. When method (i.e. method body) gets passed, it doesn't trigger 'method_missing'
  //    because it doesn't know the name of the actual method.
  //    Used internally by Opal to invoke 'super'.
  //
  // @example
  //   var my_array = [1, 2, 3, 4]
  //   Opal.send(my_array, 'length')                    # => 4
  //   Opal.send(my_array, my_array.$length)            # => 4
  //
  //   Opal.send(my_array, 'reverse!')                  # => [4, 3, 2, 1]
  //   Opal.send(my_array, my_array['$reverse!']')      # => [4, 3, 2, 1]
  //
  // @param recv [Object] ruby object
  // @param method [Function, String] method body or name of the method
  // @param args [Array] arguments that will be passed to the method call
  // @param block [Function] ruby block
  // @param blockopts [Object, Number] optional properties to set on the block
  // @return [Object] returning value of the method call
  Opal.send = function(recv, method, args, block, blockopts) {
    var body;

    if (typeof(method) === 'function') {
      body = method;
      method = null;
    } else if (typeof(method) === 'string') {
      body = recv['$'+method];
    } else {
      throw Opal.NameError.$new("Passed method should be a string or a function");
    }

    return Opal.send2(recv, body, method, args, block, blockopts);
  };

  Opal.send2 = function(recv, body, method, args, block, blockopts) {
    if (body == null && method != null && recv.$method_missing) {
      body = recv.$method_missing;
      args = [method].concat(args);
    }

    apply_blockopts(block, blockopts);

    if (typeof block === 'function') body.$$p = block;
    return body.apply(recv, args);
  };

  Opal.refined_send = function(refinement_groups, recv, method, args, block, blockopts) {
    var i, j, k, ancestors, ancestor, refinements, refinement, refine_modules, refine_module, body;

    if (recv.hasOwnProperty('$$meta')) {
      ancestors = Opal.ancestors(recv.$$meta);
    } else {
      ancestors = Opal.ancestors(recv.$$class);
    }

    // For all ancestors that there are, starting from the closest to the furthest...
    for (i = 0; i < ancestors.length; i++) {
      ancestor = Opal.id(ancestors[i]);
      // For all refinement groups there are, starting from the closest scope to the furthest...
      for (j = 0; j < refinement_groups.length; j++) {
        refinements = refinement_groups[j];
        // For all refinements there are, starting from the last `using` call to the furthest...
        for (k = refinements.length - 1; k >= 0; k--) {
          refinement = refinements[k];
          if (typeof refinement.$$refine_modules === 'undefined') continue;
          // A single module being given as an argument of the `using` call contains multiple
          // refinement modules
          refine_modules = refinement.$$refine_modules;
          // Does this module refine a given call for a given ancestor module?
          if (typeof refine_modules[ancestor] !== 'undefined') {
            refine_module = refine_modules[ancestor];
            // Does this module define a method we want to call?
            if (typeof refine_module.$$prototype['$'+method] !== 'undefined') {
              body = refine_module.$$prototype['$'+method];
              return Opal.send2(recv, body, method, args, block, blockopts);
            }
          }
        }
      }
    }

    return Opal.send(recv, method, args, block, blockopts);
  };

  Opal.lambda = function(block, blockopts) {
    block.$$is_lambda = true;

    apply_blockopts(block, blockopts);

    return block;
  };

  // Used to define methods on an object. This is a helper method, used by the
  // compiled source to define methods on special case objects when the compiler
  // can not determine the destination object, or the object is a Module
  // instance. This can get called by `Module#define_method` as well.
  //
  // ## Modules
  //
  // Any method defined on a module will come through this runtime helper.
  // The method is added to the module body, and the owner of the method is
  // set to be the module itself. This is used later when choosing which
  // method should show on a class if more than 1 included modules define
  // the same method. Finally, if the module is in `module_function` mode,
  // then the method is also defined onto the module itself.
  //
  // ## Classes
  //
  // This helper will only be called for classes when a method is being
  // defined indirectly; either through `Module#define_method`, or by a
  // literal `def` method inside an `instance_eval` or `class_eval` body. In
  // either case, the method is simply added to the class' prototype. A special
  // exception exists for `BasicObject` and `Object`. These two classes are
  // special because they are used in toll-free bridged classes. In each of
  // these two cases, extra work is required to define the methods on toll-free
  // bridged class' prototypes as well.
  //
  // ## Objects
  //
  // If a simple ruby object is the object, then the method is simply just
  // defined on the object as a singleton method. This would be the case when
  // a method is defined inside an `instance_eval` block.
  //
  // @param obj  [Object, Class] the actual obj to define method for
  // @param jsid [String] the JavaScript friendly method name (e.g. '$foo')
  // @param body [JS.Function] the literal JavaScript function used as method
  // @param blockopts [Object, Number] optional properties to set on the body
  // @return [null]
  //
  Opal.def = function(obj, jsid, body, blockopts) {
    apply_blockopts(body, blockopts);

    // Special case for a method definition in the
    // top-level namespace
    if (obj === Opal.top) {
      return Opal.defn(Opal.Object, jsid, body);
    }
    // if instance_eval is invoked on a module/class, it sets inst_eval_mod
    else if (!obj.$$eval && obj.$$is_a_module) {
      return Opal.defn(obj, jsid, body);
    }
    else {
      return Opal.defs(obj, jsid, body);
    }
  };

  // Define method on a module or class (see Opal.def).
  Opal.defn = function(module, jsid, body) {
    body.displayName = jsid;
    body.$$owner = module;

    var name = jsid.substr(1);

    var proto = module.$$prototype;
    if (proto.hasOwnProperty('$$dummy')) {
      proto = proto.$$define_methods_on;
    }
    $prop(proto, jsid, body);

    if (module.$$is_module) {
      if (module.$$module_function) {
        Opal.defs(module, jsid, body)
      }

      for (var i = 0, iclasses = module.$$iclasses, length = iclasses.length; i < length; i++) {
        var iclass = iclasses[i];
        $prop(iclass, jsid, body);
      }
    }

    var singleton_of = module.$$singleton_of;
    if (module.$method_added && !module.$method_added.$$stub && !singleton_of) {
      module.$method_added(name);
    }
    else if (singleton_of && singleton_of.$singleton_method_added && !singleton_of.$singleton_method_added.$$stub) {
      singleton_of.$singleton_method_added(name);
    }

    return name;
  };

  // Define a singleton method on the given object (see Opal.def).
  Opal.defs = function(obj, jsid, body, blockopts) {
    apply_blockopts(body, blockopts);

    if (obj.$$is_string || obj.$$is_number) {
      throw Opal.TypeError.$new("can't define singleton");
    }
    return Opal.defn(Opal.get_singleton_class(obj), jsid, body);
  };

  // Called from #remove_method.
  Opal.rdef = function(obj, jsid) {
    if (!$has_own.call(obj.$$prototype, jsid)) {
      throw Opal.NameError.$new("method '" + jsid.substr(1) + "' not defined in " + obj.$name());
    }

    delete obj.$$prototype[jsid];

    if (obj.$$is_singleton) {
      if (obj.$$prototype.$singleton_method_removed && !obj.$$prototype.$singleton_method_removed.$$stub) {
        obj.$$prototype.$singleton_method_removed(jsid.substr(1));
      }
    }
    else {
      if (obj.$method_removed && !obj.$method_removed.$$stub) {
        obj.$method_removed(jsid.substr(1));
      }
    }
  };

  // Called from #undef_method.
  Opal.udef = function(obj, jsid) {
    if (!obj.$$prototype[jsid] || obj.$$prototype[jsid].$$stub) {
      throw Opal.NameError.$new("method '" + jsid.substr(1) + "' not defined in " + obj.$name());
    }

    Opal.add_stub_for(obj.$$prototype, jsid);

    if (obj.$$is_singleton) {
      if (obj.$$prototype.$singleton_method_undefined && !obj.$$prototype.$singleton_method_undefined.$$stub) {
        obj.$$prototype.$singleton_method_undefined(jsid.substr(1));
      }
    }
    else {
      if (obj.$method_undefined && !obj.$method_undefined.$$stub) {
        obj.$method_undefined(jsid.substr(1));
      }
    }
  };

  function is_method_body(body) {
    return (typeof(body) === "function" && !body.$$stub);
  }

  Opal.alias = function(obj, name, old) {
    var id     = '$' + name,
        old_id = '$' + old,
        body,
        alias;

    // Aliasing on main means aliasing on Object...
    if (typeof obj.$$prototype === 'undefined') {
      obj = Opal.Object;
    }

    body = obj.$$prototype['$' + old];

    // When running inside #instance_eval the alias refers to class methods.
    if (obj.$$eval) {
      return Opal.alias(Opal.get_singleton_class(obj), name, old);
    }

    if (!is_method_body(body)) {
      var ancestor = obj.$$super;

      while (typeof(body) !== "function" && ancestor) {
        body     = ancestor[old_id];
        ancestor = ancestor.$$super;
      }

      if (!is_method_body(body) && obj.$$is_module) {
        // try to look into Object
        body = Opal.Object.$$prototype[old_id]
      }

      if (!is_method_body(body)) {
        throw Opal.NameError.$new("undefined method `" + old + "' for class `" + obj.$name() + "'")
      }
    }

    // If the body is itself an alias use the original body
    // to keep the max depth at 1.
    if (body.$$alias_of) body = body.$$alias_of;

    // We need a wrapper because otherwise properties
    // would be overwritten on the original body.
    alias = function() {
      var block = alias.$$p, args, i, ii;

      args = new Array(arguments.length);
      for(i = 0, ii = arguments.length; i < ii; i++) {
        args[i] = arguments[i];
      }

      delete alias.$$p;

      return Opal.send(this, body, args, block);
    };

    // Assign the 'length' value with defineProperty because
    // in strict mode the property is not writable.
    // It doesn't work in older browsers (like Chrome 38), where
    // an exception is thrown breaking Opal altogether.
    try {
      Object.defineProperty(alias, 'length', { value: body.length });
    } catch (e) {}

    // Try to make the browser pick the right name
    alias.displayName       = name;

    alias.$$arity           = body.$$arity;
    alias.$$parameters      = body.$$parameters;
    alias.$$source_location = body.$$source_location;
    alias.$$alias_of        = body;
    alias.$$alias_name      = name;

    Opal.defn(obj, id, alias);

    return obj;
  };

  Opal.alias_gvar = function(new_name, old_name) {
    Object.defineProperty(Opal.gvars, new_name, {
      configurable: true,
      enumerable: true,
      get: function() {
        return Opal.gvars[old_name];
      },
      set: function(new_value) {
        Opal.gvars[old_name] = new_value;
      }
    });
    return nil;
  }

  Opal.alias_native = function(obj, name, native_name) {
    var id   = '$' + name,
        body = obj.$$prototype[native_name];

    if (typeof(body) !== "function" || body.$$stub) {
      throw Opal.NameError.$new("undefined native method `" + native_name + "' for class `" + obj.$name() + "'")
    }

    Opal.defn(obj, id, body);

    return obj;
  };


  // Hashes
  // ------

  Opal.hash_init = function(hash) {
    hash.$$smap = Object.create(null);
    hash.$$map  = Object.create(null);
    hash.$$keys = [];
  };

  Opal.hash_clone = function(from_hash, to_hash) {
    to_hash.$$none = from_hash.$$none;
    to_hash.$$proc = from_hash.$$proc;

    for (var i = 0, keys = from_hash.$$keys, smap = from_hash.$$smap, len = keys.length, key, value; i < len; i++) {
      key = keys[i];

      if (key.$$is_string) {
        value = smap[key];
      } else {
        value = key.value;
        key = key.key;
      }

      Opal.hash_put(to_hash, key, value);
    }
  };

  Opal.hash_put = function(hash, key, value) {
    if (key.$$is_string) {
      if (!$has_own.call(hash.$$smap, key)) {
        hash.$$keys.push(key);
      }
      hash.$$smap[key] = value;
      return;
    }

    var key_hash, bucket, last_bucket;
    key_hash = hash.$$by_identity ? Opal.id(key) : key.$hash();

    if (!$has_own.call(hash.$$map, key_hash)) {
      bucket = {key: key, key_hash: key_hash, value: value};
      hash.$$keys.push(bucket);
      hash.$$map[key_hash] = bucket;
      return;
    }

    bucket = hash.$$map[key_hash];

    while (bucket) {
      if (key === bucket.key || key['$eql?'](bucket.key)) {
        last_bucket = undefined;
        bucket.value = value;
        break;
      }
      last_bucket = bucket;
      bucket = bucket.next;
    }

    if (last_bucket) {
      bucket = {key: key, key_hash: key_hash, value: value};
      hash.$$keys.push(bucket);
      last_bucket.next = bucket;
    }
  };

  Opal.hash_get = function(hash, key) {
    if (key.$$is_string) {
      if ($has_own.call(hash.$$smap, key)) {
        return hash.$$smap[key];
      }
      return;
    }

    var key_hash, bucket;
    key_hash = hash.$$by_identity ? Opal.id(key) : key.$hash();

    if ($has_own.call(hash.$$map, key_hash)) {
      bucket = hash.$$map[key_hash];

      while (bucket) {
        if (key === bucket.key || key['$eql?'](bucket.key)) {
          return bucket.value;
        }
        bucket = bucket.next;
      }
    }
  };

  Opal.hash_delete = function(hash, key) {
    var i, keys = hash.$$keys, length = keys.length, value, key_tmp;

    if (key.$$is_string) {
      if (typeof key !== "string") key = key.valueOf();

      if (!$has_own.call(hash.$$smap, key)) {
        return;
      }

      for (i = 0; i < length; i++) {
        key_tmp = keys[i];

        if (key_tmp.$$is_string && typeof key_tmp !== "string") {
          key_tmp = key_tmp.valueOf();
        }

        if (key_tmp === key) {
          keys.splice(i, 1);
          break;
        }
      }

      value = hash.$$smap[key];
      delete hash.$$smap[key];
      return value;
    }

    var key_hash = key.$hash();

    if (!$has_own.call(hash.$$map, key_hash)) {
      return;
    }

    var bucket = hash.$$map[key_hash], last_bucket;

    while (bucket) {
      if (key === bucket.key || key['$eql?'](bucket.key)) {
        value = bucket.value;

        for (i = 0; i < length; i++) {
          if (keys[i] === bucket) {
            keys.splice(i, 1);
            break;
          }
        }

        if (last_bucket && bucket.next) {
          last_bucket.next = bucket.next;
        }
        else if (last_bucket) {
          delete last_bucket.next;
        }
        else if (bucket.next) {
          hash.$$map[key_hash] = bucket.next;
        }
        else {
          delete hash.$$map[key_hash];
        }

        return value;
      }
      last_bucket = bucket;
      bucket = bucket.next;
    }
  };

  Opal.hash_rehash = function(hash) {
    for (var i = 0, length = hash.$$keys.length, key_hash, bucket, last_bucket; i < length; i++) {

      if (hash.$$keys[i].$$is_string) {
        continue;
      }

      key_hash = hash.$$keys[i].key.$hash();

      if (key_hash === hash.$$keys[i].key_hash) {
        continue;
      }

      bucket = hash.$$map[hash.$$keys[i].key_hash];
      last_bucket = undefined;

      while (bucket) {
        if (bucket === hash.$$keys[i]) {
          if (last_bucket && bucket.next) {
            last_bucket.next = bucket.next;
          }
          else if (last_bucket) {
            delete last_bucket.next;
          }
          else if (bucket.next) {
            hash.$$map[hash.$$keys[i].key_hash] = bucket.next;
          }
          else {
            delete hash.$$map[hash.$$keys[i].key_hash];
          }
          break;
        }
        last_bucket = bucket;
        bucket = bucket.next;
      }

      hash.$$keys[i].key_hash = key_hash;

      if (!$has_own.call(hash.$$map, key_hash)) {
        hash.$$map[key_hash] = hash.$$keys[i];
        continue;
      }

      bucket = hash.$$map[key_hash];
      last_bucket = undefined;

      while (bucket) {
        if (bucket === hash.$$keys[i]) {
          last_bucket = undefined;
          break;
        }
        last_bucket = bucket;
        bucket = bucket.next;
      }

      if (last_bucket) {
        last_bucket.next = hash.$$keys[i];
      }
    }
  };

  Opal.hash = function() {
    var arguments_length = arguments.length, args, hash, i, length, key, value;

    if (arguments_length === 1 && arguments[0].$$is_hash) {
      return arguments[0];
    }

    hash = new Opal.Hash();
    Opal.hash_init(hash);

    if (arguments_length === 1 && arguments[0].$$is_array) {
      args = arguments[0];
      length = args.length;

      for (i = 0; i < length; i++) {
        if (args[i].length !== 2) {
          throw Opal.ArgumentError.$new("value not of length 2: " + args[i].$inspect());
        }

        key = args[i][0];
        value = args[i][1];

        Opal.hash_put(hash, key, value);
      }

      return hash;
    }

    if (arguments_length === 1) {
      args = arguments[0];
      for (key in args) {
        if ($has_own.call(args, key)) {
          value = args[key];

          Opal.hash_put(hash, key, value);
        }
      }

      return hash;
    }

    if (arguments_length % 2 !== 0) {
      throw Opal.ArgumentError.$new("odd number of arguments for Hash");
    }

    for (i = 0; i < arguments_length; i += 2) {
      key = arguments[i];
      value = arguments[i + 1];

      Opal.hash_put(hash, key, value);
    }

    return hash;
  };

  // A faster Hash creator for hashes that just use symbols and
  // strings as keys. The map and keys array can be constructed at
  // compile time, so they are just added here by the constructor
  // function.
  //
  Opal.hash2 = function(keys, smap) {
    var hash = new Opal.Hash();

    hash.$$smap = smap;
    hash.$$map  = Object.create(null);
    hash.$$keys = keys;

    return hash;
  };

  // Create a new range instance with first and last values, and whether the
  // range excludes the last value.
  //
  Opal.range = function(first, last, exc) {
    var range         = new Opal.Range();
        range.begin   = first;
        range.end     = last;
        range.excl    = exc;

    return range;
  };

  // Get the ivar name for a given name.
  // Mostly adds a trailing $ to reserved names.
  //
  Opal.ivar = function(name) {
    if (
        // properties
        name === "constructor" ||
        name === "displayName" ||
        name === "__count__" ||
        name === "__noSuchMethod__" ||
        name === "__parent__" ||
        name === "__proto__" ||

        // methods
        name === "hasOwnProperty" ||
        name === "valueOf"
       )
    {
      return name + "$";
    }

    return name;
  };


  // Regexps
  // -------

  // Escape Regexp special chars letting the resulting string be used to build
  // a new Regexp.
  //
  Opal.escape_regexp = function(str) {
    return str.replace(/([-[\]\/{}()*+?.^$\\| ])/g, '\\$1')
              .replace(/[\n]/g, '\\n')
              .replace(/[\r]/g, '\\r')
              .replace(/[\f]/g, '\\f')
              .replace(/[\t]/g, '\\t');
  };

  // Create a global Regexp from a RegExp object and cache the result
  // on the object itself ($$g attribute).
  //
  Opal.global_regexp = function(pattern) {
    if (pattern.global) {
      return pattern; // RegExp already has the global flag
    }
    if (pattern.$$g == null) {
      pattern.$$g = new RegExp(pattern.source, (pattern.multiline ? 'gm' : 'g') + (pattern.ignoreCase ? 'i' : ''));
    } else {
      pattern.$$g.lastIndex = null; // reset lastIndex property
    }
    return pattern.$$g;
  };

  // Create a global multiline Regexp from a RegExp object and cache the result
  // on the object itself ($$gm or $$g attribute).
  //
  Opal.global_multiline_regexp = function(pattern) {
    var result;
    if (pattern.multiline) {
      if (pattern.global) {
        return pattern; // RegExp already has the global and multiline flag
      }
      // we are using the $$g attribute because the Regexp is already multiline
      if (pattern.$$g != null) {
        result = pattern.$$g;
      } else {
        result = pattern.$$g = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
      }
    } else if (pattern.$$gm != null) {
      result = pattern.$$gm;
    } else {
      result = pattern.$$gm = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
    }
    result.lastIndex = null; // reset lastIndex property
    return result;
  };

  // Combine multiple regexp parts together
  Opal.regexp = function(parts, flags) {
    var part;
    var ignoreCase = typeof flags !== 'undefined' && flags && flags.indexOf('i') >= 0;

    for (var i = 0, ii = parts.length; i < ii; i++) {
      part = parts[i];
      if (part instanceof RegExp) {
        if (part.ignoreCase !== ignoreCase)
          Opal.Kernel.$warn(
            "ignore case doesn't match for " + part.source.$inspect(),
            Opal.hash({uplevel: 1})
          )

        part = part.source;
      }
      if (part === '') part = '(?:' + part + ')';
      parts[i] = part;
    }

    if (flags) {
      return new RegExp(parts.join(''), flags);
    } else {
      return new RegExp(parts.join(''));
    }
  };

  // Require system
  // --------------

  Opal.modules         = {};
  Opal.loaded_features = ['corelib/runtime'];
  Opal.current_dir     = '.';
  Opal.require_table   = {'corelib/runtime': true};

  Opal.normalize = function(path) {
    var parts, part, new_parts = [], SEPARATOR = '/';

    if (Opal.current_dir !== '.') {
      path = Opal.current_dir.replace(/\/*$/, '/') + path;
    }

    path = path.replace(/^\.\//, '');
    path = path.replace(/\.(rb|opal|js)$/, '');
    parts = path.split(SEPARATOR);

    for (var i = 0, ii = parts.length; i < ii; i++) {
      part = parts[i];
      if (part === '') continue;
      (part === '..') ? new_parts.pop() : new_parts.push(part)
    }

    return new_parts.join(SEPARATOR);
  };

  Opal.loaded = function(paths) {
    var i, l, path;

    for (i = 0, l = paths.length; i < l; i++) {
      path = Opal.normalize(paths[i]);

      if (Opal.require_table[path]) {
        continue;
      }

      Opal.loaded_features.push(path);
      Opal.require_table[path] = true;
    }
  };

  Opal.load = function(path) {
    path = Opal.normalize(path);

    Opal.loaded([path]);

    var module = Opal.modules[path];

    if (module) {
      var retval = module(Opal);
      if (typeof Promise !== 'undefined' && retval instanceof Promise) {
        // A special case of require having an async top:
        // We will need to await it.
        return retval.then($return_val(true));
      }
    }
    else {
      var severity = Opal.config.missing_require_severity;
      var message  = 'cannot load such file -- ' + path;

      if (severity === "error") {
        if (Opal.LoadError) {
          throw Opal.LoadError.$new(message)
        } else {
          throw message
        }
      }
      else if (severity === "warning") {
        console.warn('WARNING: LoadError: ' + message);
      }
    }

    return true;
  };

  Opal.require = function(path) {
    path = Opal.normalize(path);

    if (Opal.require_table[path]) {
      return false;
    }

    return Opal.load(path);
  };


  // Strings
  // -------

  Opal.encodings = Object.create(null);

  // Sets the encoding on a string, will treat string literals as frozen strings
  // raising a FrozenError.
  //
  // @param str [String] the string on which the encoding should be set
  // @param name [String] the canonical name of the encoding
  // @param type [String] possible values are either `"encoding"`, `"internal_encoding"`, or `undefined
  Opal.set_encoding = function(str, name, type) {
    if (typeof type === "undefined") type = "encoding";
    if (typeof str === 'string' || str.$$frozen === true)
      throw Opal.FrozenError.$new("can't modify frozen String");

    var encoding = Opal.find_encoding(name);

    if (encoding === str[type]) { return str; }

    str[type] = encoding;

    return str;
  };

  // Fetches the encoding for the given name or raises ArgumentError.
  Opal.find_encoding = function(name) {
    var register = Opal.encodings;
    var encoding = register[name] || register[name.toUpperCase()];
    if (!encoding) throw Opal.ArgumentError.$new("unknown encoding name - " + name);
    return encoding;
  }

  // @returns a String object with the encoding set from a string literal
  Opal.enc = function(str, name) {
    var dup = new String(str);
    dup = Opal.set_encoding(dup, name);
    dup.internal_encoding = dup.encoding;
    return dup
  }

  // @returns a String object with the internal encoding set to Binary
  Opal.binary = function(str) {
    var dup = new String(str);
    return Opal.set_encoding(dup, "binary", "internal_encoding");
  }

  Opal.last_promise = null;
  Opal.promise_unhandled_exception = false;

  // Run a block of code, but if it returns a Promise, don't run the next
  // one, but queue it.
  Opal.queue = function(proc) {
    if (Opal.last_promise) {
      // The async path is taken only if anything before returned a
      // Promise(V2).
      Opal.last_promise = Opal.last_promise.then(function() {
        if (!Opal.promise_unhandled_exception) return proc(Opal);
      })['catch'](function(error) {
        if (Opal.respond_to(error, '$full_message')) {
          error = error.$full_message();
        }
        console.error(error);
        // Abort further execution
        Opal.promise_unhandled_exception = true;
        Opal.exit(1);
      });
      return Opal.last_promise;
    }
    else {
      var ret = proc(Opal);
      if (typeof Promise === 'function' && typeof ret === 'object' && ret instanceof Promise) {
        Opal.last_promise = ret;
      }
      return ret;
    }
  }

  // Operator helpers
  // ----------------
  Opal.rb_plus   = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l + r : l['$+'](r); }
  Opal.rb_minus  = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l - r : l['$-'](r); }
  Opal.rb_times  = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l * r : l['$*'](r); }
  Opal.rb_divide = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l / r : l['$/'](r); }
  Opal.rb_lt     = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l < r : l['$<'](r); }
  Opal.rb_gt     = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l > r : l['$>'](r); }
  Opal.rb_le     = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l <= r : l['$<='](r); }
  Opal.rb_ge     = function(l,r) { return (typeof(l) === 'number' && typeof(r) === 'number') ? l >= r : l['$>='](r); }

  // Optimized helpers for calls like $truthy((a)['$==='](b)) -> $eqeqeq(a, b)
  function $eqeq(lhs, rhs) {
    if ((typeof lhs === 'number' && typeof rhs === 'number') ||
        (typeof lhs === 'string' && typeof rhs === 'string')) {
      return lhs === rhs;
    }
    return $truthy((lhs)['$=='](rhs));
  };
  Opal.eqeq = $eqeq;

  Opal.eqeqeq = function(lhs, rhs) {
    if ((typeof lhs === 'number' && typeof rhs === 'number') ||
        (typeof lhs === 'string' && typeof rhs === 'string')) {
      return lhs === rhs;
    }
    return $truthy((lhs)['$==='](rhs));
  };
  Opal.neqeq = function(lhs, rhs) {
    if ((typeof lhs === 'number' && typeof rhs === 'number') ||
        (typeof lhs === 'string' && typeof rhs === 'string')) {
      return lhs !== rhs;
    }
    return $truthy((lhs)['$!='](rhs));
  };
  Opal.not = function(arg) {
    if (true === arg) return false;
    if (undefined === arg || null === arg || false === arg || nil === arg) return true;
    return $truthy(arg['$!']());
  }

  // Shortcuts - optimized function generators for simple kinds of functions
  function $return_val(arg) {
    return function() {
      return arg;
    }
  }
  Opal.return_val = $return_val;

  Opal.return_self = function() {
    return this;
  }
  Opal.return_ivar = function(ivar) {
    return function() {
      if (this[ivar] == null) this[ivar] = nil;
      return this[ivar];
    }
  }
  Opal.assign_ivar = function(ivar) {
    return function(val) {
      return this[ivar] = val;
    }
  }
  Opal.assign_ivar_val = function(ivar, static_val) {
    return function() {
      return this[ivar] = static_val;
    }
  }

  // Initialization
  // --------------
  Opal.BasicObject = BasicObject = Opal.allocate_class('BasicObject', null);
  Opal.Object      = _Object     = Opal.allocate_class('Object', Opal.BasicObject);
  Opal.Module      = Module      = Opal.allocate_class('Module', Opal.Object);
  Opal.Class       = Class       = Opal.allocate_class('Class', Opal.Module);
  Opal.Opal        = _Opal       = Opal.allocate_module('Opal');
  Opal.Kernel      = Kernel      = Opal.allocate_module('Kernel');

  $set_proto(Opal.BasicObject, Opal.Class.$$prototype);
  $set_proto(Opal.Object, Opal.Class.$$prototype);
  $set_proto(Opal.Module, Opal.Class.$$prototype);
  $set_proto(Opal.Class, Opal.Class.$$prototype);

  // BasicObject can reach itself, avoid const_set to skip the $$base_module logic
  BasicObject.$$const["BasicObject"] = BasicObject;

  // Assign basic constants
  $const_set(_Object, "BasicObject",  BasicObject);
  $const_set(_Object, "Object",       _Object);
  $const_set(_Object, "Module",       Module);
  $const_set(_Object, "Class",        Class);
  $const_set(_Object, "Opal",         _Opal);
  $const_set(_Object, "Kernel",       Kernel);

  // Fix booted classes to have correct .class value
  BasicObject.$$class = Class;
  _Object.$$class     = Class;
  Module.$$class      = Class;
  Class.$$class       = Class;
  _Opal.$$class       = Module;
  Kernel.$$class      = Module;

  // Forward .toString() to #to_s
  $prop(_Object.$$prototype, 'toString', function() {
    var to_s = this.$to_s();
    if (to_s.$$is_string && typeof(to_s) === 'object') {
      // a string created using new String('string')
      return to_s.valueOf();
    } else {
      return to_s;
    }
  });

  // Make Kernel#require immediately available as it's needed to require all the
  // other corelib files.
  $prop(_Object.$$prototype, '$require', Opal.require);

  // Instantiate the main object
  Opal.top = new _Object();
  Opal.top.$to_s = Opal.top.$inspect = $return_val('main');
  Opal.top.$define_method = top_define_method;

  // Foward calls to define_method on the top object to Object
  function top_define_method() {
    var args = Opal.slice.call(arguments);
    var block = top_define_method.$$p;
    delete top_define_method.$$p;
    return Opal.send(_Object, 'define_method', args, block)
  };

  // Nil
  Opal.NilClass = Opal.allocate_class('NilClass', Opal.Object);
  $const_set(_Object, 'NilClass', Opal.NilClass);
  nil = Opal.nil = new Opal.NilClass();
  nil.$$id = nil_id;
  nil.call = nil.apply = function() { throw Opal.LocalJumpError.$new('no block given'); };

  // Errors
  Opal.breaker  = new Error('unexpected break (old)');
  Opal.returner = new Error('unexpected return');
  TypeError.$$super = Error;
}).call(this);
Opal.loaded(["corelib/runtime.js"]);
Opal.modules["corelib/helpers"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $type_error = Opal.type_error, $coerce_to = Opal.coerce_to, $module = Opal.module, $defs = Opal.defs, $eqeqeq = Opal.eqeqeq, $Kernel = Opal.Kernel, $truthy = Opal.truthy, $Opal = Opal.Opal;

  Opal.add_stubs('===,raise,respond_to?,nil?,__send__,<=>,class,coerce_to!,new,to_s,__id__');
  return (function($base) {
    var self = $module($base, 'Opal');

    
    
    $defs(self, '$bridge', function $$bridge(constructor, klass) {
      
      return Opal.bridge(constructor, klass);
    }, 2);
    $defs(self, '$coerce_to!', function $Opal_coerce_to$excl$1(object, type, method, $a) {
      var $post_args, args, coerced = nil;

      
      
      $post_args = Opal.slice.call(arguments, 3);
      
      args = $post_args;;
      coerced = $coerce_to(object, type, method, args);
      if (!$eqeqeq(type, coerced)) {
        $Kernel.$raise($type_error(object, type, method, coerced))
      };
      return coerced;
    }, -4);
    $defs(self, '$coerce_to?', function $Opal_coerce_to$ques$2(object, type, method, $a) {
      var $post_args, args, coerced = nil;

      
      
      $post_args = Opal.slice.call(arguments, 3);
      
      args = $post_args;;
      if (!$truthy(object['$respond_to?'](method))) {
        return nil
      };
      coerced = $coerce_to(object, type, method, args);
      if ($truthy(coerced['$nil?']())) {
        return nil
      };
      if (!$eqeqeq(type, coerced)) {
        $Kernel.$raise($type_error(object, type, method, coerced))
      };
      return coerced;
    }, -4);
    $defs(self, '$try_convert', function $$try_convert(object, type, method) {
      
      
      if ($eqeqeq(type, object)) {
        return object
      };
      if ($truthy(object['$respond_to?'](method))) {
        return object.$__send__(method)
      } else {
        return nil
      };
    }, 3);
    $defs(self, '$compare', function $$compare(a, b) {
      var compare = nil;

      
      compare = a['$<=>'](b);
      if ($truthy(compare === nil)) {
        $Kernel.$raise($$$('ArgumentError'), "comparison of " + (a.$class()) + " with " + (b.$class()) + " failed")
      };
      return compare;
    }, 2);
    $defs(self, '$destructure', function $$destructure(args) {
      
      
      if (args.length == 1) {
        return args[0];
      }
      else if (args.$$is_array) {
        return args;
      }
      else {
        var args_ary = new Array(args.length);
        for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = args[i]; }

        return args_ary;
      }
    
    }, 1);
    $defs(self, '$respond_to?', function $Opal_respond_to$ques$3(obj, method, include_all) {
      
      
      
      if (include_all == null) include_all = false;;
      
      if (obj == null || !obj.$$class) {
        return false;
      }
    ;
      return obj['$respond_to?'](method, include_all);
    }, -3);
    $defs(self, '$instance_variable_name!', function $Opal_instance_variable_name$excl$4(name) {
      
      
      name = $Opal['$coerce_to!'](name, $$$('String'), "to_str");
      if (!$truthy(/^@[a-zA-Z_][a-zA-Z0-9_]*?$/.test(name))) {
        $Kernel.$raise($$$('NameError').$new("'" + (name) + "' is not allowed as an instance variable name", name))
      };
      return name;
    }, 1);
    $defs(self, '$class_variable_name!', function $Opal_class_variable_name$excl$5(name) {
      
      
      name = $Opal['$coerce_to!'](name, $$$('String'), "to_str");
      if ($truthy(name.length < 3 || name.slice(0,2) !== '@@')) {
        $Kernel.$raise($$$('NameError').$new("`" + (name) + "' is not allowed as a class variable name", name))
      };
      return name;
    }, 1);
    $defs(self, '$const_name?', function $Opal_const_name$ques$6(const_name) {
      
      
      if (typeof const_name !== 'string') {
        (const_name = $Opal['$coerce_to!'](const_name, $$$('String'), "to_str"))
      }

      return const_name[0] === const_name[0].toUpperCase()
    
    }, 1);
    $defs(self, '$const_name!', function $Opal_const_name$excl$7(const_name) {
      var $a, self = this;

      
      if ($truthy((($a = $$$('::', 'String', 'skip_raise')) ? 'constant' : nil))) {
        const_name = $Opal['$coerce_to!'](const_name, $$$('String'), "to_str")
      };
      
      if (!const_name || const_name[0] != const_name[0].toUpperCase()) {
        self.$raise($$$('NameError'), "wrong constant name " + (const_name))
      }
    ;
      return const_name;
    }, 1);
    $defs(self, '$pristine', function $$pristine(owner_class, $a) {
      var $post_args, method_names;

      
      
      $post_args = Opal.slice.call(arguments, 1);
      
      method_names = $post_args;;
      
      var method_name, method;
      for (var i = method_names.length - 1; i >= 0; i--) {
        method_name = method_names[i];
        method = owner_class.$$prototype['$'+method_name];

        if (method && !method.$$stub) {
          method.$$pristine = true;
        }
      }
    ;
      return nil;
    }, -2);
    var inspect_stack = [];
    return $defs(self, '$inspect', function $$inspect(value) {
      var e = nil;

      
      ;
      var pushed = false;
      
      return (function() { try {
      try {
        
        
        if (value === null) {
          // JS null value
          return 'null';
        }
        else if (value === undefined) {
          // JS undefined value
          return 'undefined';
        }
        else if (typeof value.$$class === 'undefined') {
          // JS object / other value that is not bridged
          return Object.prototype.toString.apply(value);
        }
        else if (typeof value.$inspect !== 'function' || value.$inspect.$$stub) {
          // BasicObject and friends
          return "#<" + (value.$$class) + ":0x" + (value.$__id__().$to_s(16)) + ">"
        }
        else if (inspect_stack.indexOf(value.$__id__()) !== -1) {
          // inspect recursing inside inspect to find out about the
          // same object
          return "#<" + (value.$$class) + ":0x" + (value.$__id__().$to_s(16)) + ">"
        }
        else {
          // anything supporting Opal
          inspect_stack.push(value.$__id__());
          pushed = true;
          return value.$inspect();
        }
      ;
        return nil;
      } catch ($err) {
        if (Opal.rescue($err, [$$$('Exception')])) {(e = $err)
          try {
            return "#<" + (value.$$class) + ":0x" + (value.$__id__().$to_s(16)) + ">"
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      }
      } finally {
        if (pushed) inspect_stack.pop()
      }; })();;
    }, -1);
  })('::')
};

Opal.modules["corelib/module"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $coerce_to = Opal.coerce_to, $const_set = Opal.const_set, $Object = Opal.Object, $return_ivar = Opal.return_ivar, $assign_ivar = Opal.assign_ivar, $ivar = Opal.ivar, $klass = Opal.klass, $defs = Opal.defs, $send = Opal.send, $def = Opal.def, $eqeqeq = Opal.eqeqeq, $Module = Opal.Module, $Kernel = Opal.Kernel, $rb_lt = Opal.rb_lt, $rb_gt = Opal.rb_gt, $to_a = Opal.to_a, $hash2 = Opal.hash2, $Opal = Opal.Opal, $eqeq = Opal.eqeq, $return_val = Opal.return_val, $lambda = Opal.lambda, $range = Opal.range, $send2 = Opal.send2, $find_super = Opal.find_super, $alias = Opal.alias;

  Opal.add_stubs('module_eval,to_proc,===,raise,equal?,<,>,nil?,attr_reader,attr_writer,warn,attr_accessor,const_name?,class_variable_name!,const_name!,=~,new,inject,split,const_get,==,start_with?,!~,bind,call,class,append_features,included,name,cover?,size,merge,compile,proc,any?,prepend_features,prepended,to_s,__id__,constants,include?,copy_class_variables,copy_constants,class_exec,module_exec,inspect');
  
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Module');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    $defs(self, '$allocate', function $$allocate() {
      var self = this;

      
      var module = Opal.allocate_module(nil, function(){});
      // Link the prototype of Module subclasses
      if (self !== Opal.Module) Object.setPrototypeOf(module, self.$$prototype);
      return module;
    
    }, 0);
    
    $def(self, '$initialize', function $$initialize() {
      var block = $$initialize.$$p || nil, self = this;

      delete $$initialize.$$p;
      
      ;
      if ((block !== nil)) {
        return $send(self, 'module_eval', [], block.$to_proc())
      } else {
        return nil
      };
    }, 0);
    
    $def(self, '$===', function $Module_$eq_eq_eq$1(object) {
      var self = this;

      
      if ($truthy(object == null)) {
        return false
      };
      return Opal.is_a(object, self);;
    }, 1);
    
    $def(self, '$<', function $Module_$lt$2(other) {
      var self = this;

      
      if (!$eqeqeq($Module, other)) {
        $Kernel.$raise($$$('TypeError'), "compared with non class/module")
      };
      
      var working = self,
          ancestors,
          i, length;

      if (working === other) {
        return false;
      }

      for (i = 0, ancestors = Opal.ancestors(self), length = ancestors.length; i < length; i++) {
        if (ancestors[i] === other) {
          return true;
        }
      }

      for (i = 0, ancestors = Opal.ancestors(other), length = ancestors.length; i < length; i++) {
        if (ancestors[i] === self) {
          return false;
        }
      }

      return nil;
    ;
    }, 1);
    
    $def(self, '$<=', function $Module_$lt_eq$3(other) {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self['$equal?'](other)))) {
        return $ret_or_1
      } else {
        return $rb_lt(self, other)
      }
    }, 1);
    
    $def(self, '$>', function $Module_$gt$4(other) {
      var self = this;

      
      if (!$eqeqeq($Module, other)) {
        $Kernel.$raise($$$('TypeError'), "compared with non class/module")
      };
      return $rb_lt(other, self);
    }, 1);
    
    $def(self, '$>=', function $Module_$gt_eq$5(other) {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self['$equal?'](other)))) {
        return $ret_or_1
      } else {
        return $rb_gt(self, other)
      }
    }, 1);
    
    $def(self, '$<=>', function $Module_$lt_eq_gt$6(other) {
      var self = this, lt = nil;

      
      
      if (self === other) {
        return 0;
      }
    ;
      if (!$eqeqeq($Module, other)) {
        return nil
      };
      lt = $rb_lt(self, other);
      if ($truthy(lt['$nil?']())) {
        return nil
      };
      if ($truthy(lt)) {
        return -1
      } else {
        return 1
      };
    }, 1);
    
    $def(self, '$alias_method', function $$alias_method(newname, oldname) {
      var self = this;

      
      newname = $coerce_to(newname, $$$('String'), 'to_str');
      oldname = $coerce_to(oldname, $$$('String'), 'to_str');
      Opal.alias(self, newname, oldname);
      return self;
    }, 2);
    
    $def(self, '$alias_native', function $$alias_native(mid, jsid) {
      var self = this;

      
      
      if (jsid == null) jsid = mid;;
      Opal.alias_native(self, mid, jsid);
      return self;
    }, -2);
    
    $def(self, '$ancestors', function $$ancestors() {
      var self = this;

      return Opal.ancestors(self);
    }, 0);
    
    $def(self, '$append_features', function $$append_features(includer) {
      var self = this;

      
      Opal.append_features(self, includer);
      return self;
    }, 1);
    
    $def(self, '$attr_accessor', function $$attr_accessor($a) {
      var $post_args, names, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      names = $post_args;;
      $send(self, 'attr_reader', $to_a(names));
      return $send(self, 'attr_writer', $to_a(names));
    }, -1);
    
    $def(self, '$attr', function $$attr($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      if (args.length == 2 && (args[1] === true || args[1] === false)) {
        self.$warn("optional boolean argument is obsoleted", $hash2(["uplevel"], {"uplevel": 1}))

        args[1] ? self.$attr_accessor(args[0]) : self.$attr_reader(args[0]);
        return nil;
      }
    ;
      return $send(self, 'attr_reader', $to_a(args));
    }, -1);
    
    $def(self, '$attr_reader', function $$attr_reader($a) {
      var $post_args, names, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      names = $post_args;;
      
      var proto = self.$$prototype;

      for (var i = names.length - 1; i >= 0; i--) {
        var name = names[i],
            id   = '$' + name,
            ivar = $ivar(name);

        var body = $return_ivar(ivar);

        // initialize the instance variable as nil
        Opal.prop(proto, ivar, nil);

        body.$$parameters = [];
        body.$$arity = 0;

        Opal.defn(self, id, body);
      }
    ;
      return nil;
    }, -1);
    
    $def(self, '$attr_writer', function $$attr_writer($a) {
      var $post_args, names, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      names = $post_args;;
      
      var proto = self.$$prototype;

      for (var i = names.length - 1; i >= 0; i--) {
        var name = names[i],
            id   = '$' + name + '=',
            ivar = $ivar(name);

        var body = $assign_ivar(ivar)

        body.$$parameters = [['req']];
        body.$$arity = 1;

        // initialize the instance variable as nil
        Opal.prop(proto, ivar, nil);

        Opal.defn(self, id, body);
      }
    ;
      return nil;
    }, -1);
    
    $def(self, '$autoload', function $$autoload(const$, path) {
      var self = this;

      
      if (!$$('Opal')['$const_name?'](const$)) {
        $Kernel.$raise($$$('NameError'), "autoload must be constant name: " + (const$))
      }

      if (path == "") {
        $Kernel.$raise($$$('ArgumentError'), "empty file name")
      }

      if (!self.$$const.hasOwnProperty(const$)) {
        if (!self.$$autoload) {
          self.$$autoload = {};
        }
        Opal.const_cache_version++;
        self.$$autoload[const$] = { path: path, loaded: false, required: false, success: false, exception: false };
      }
      return nil;
    
    }, 2);
    
    $def(self, '$autoload?', function $Module_autoload$ques$7(const$) {
      var self = this;

      
      if (self.$$autoload && self.$$autoload[const$] && !self.$$autoload[const$].required && !self.$$autoload[const$].success) {
        return self.$$autoload[const$].path;
      }

      var ancestors = self.$ancestors();

      for (var i = 0, length = ancestors.length; i < length; i++) {
        if (ancestors[i].$$autoload && ancestors[i].$$autoload[const$] && !ancestors[i].$$autoload[const$].required && !ancestors[i].$$autoload[const$].success) {
          return ancestors[i].$$autoload[const$].path;
        }
      }
      return nil;
    
    }, 1);
    
    $def(self, '$class_variables', function $$class_variables() {
      var self = this;

      return Object.keys(Opal.class_variables(self));
    }, 0);
    
    $def(self, '$class_variable_get', function $$class_variable_get(name) {
      var self = this;

      
      name = $Opal['$class_variable_name!'](name);
      return Opal.class_variable_get(self, name, false);;
    }, 1);
    
    $def(self, '$class_variable_set', function $$class_variable_set(name, value) {
      var self = this;

      
      name = $Opal['$class_variable_name!'](name);
      return Opal.class_variable_set(self, name, value);;
    }, 2);
    
    $def(self, '$class_variable_defined?', function $Module_class_variable_defined$ques$8(name) {
      var self = this;

      
      name = $Opal['$class_variable_name!'](name);
      return Opal.class_variables(self).hasOwnProperty(name);;
    }, 1);
    
    $def(self, '$remove_class_variable', function $$remove_class_variable(name) {
      var self = this;

      
      name = $Opal['$class_variable_name!'](name);
      
      if (Opal.hasOwnProperty.call(self.$$cvars, name)) {
        var value = self.$$cvars[name];
        delete self.$$cvars[name];
        return value;
      } else {
        $Kernel.$raise($$$('NameError'), "cannot remove " + (name) + " for " + (self))
      }
    ;
    }, 1);
    
    $def(self, '$constants', function $$constants(inherit) {
      var self = this;

      
      
      if (inherit == null) inherit = true;;
      return Opal.constants(self, inherit);;
    }, -1);
    $defs(self, '$constants', function $$constants(inherit) {
      var self = this;

      
      ;
      
      if (inherit == null) {
        var nesting = (self.$$nesting || []).concat($Object),
            constant, constants = {},
            i, ii;

        for(i = 0, ii = nesting.length; i < ii; i++) {
          for (constant in nesting[i].$$const) {
            constants[constant] = true;
          }
        }
        return Object.keys(constants);
      } else {
        return Opal.constants(self, inherit)
      }
    ;
    }, -1);
    $defs(self, '$nesting', function $$nesting() {
      var self = this;

      return self.$$nesting || [];
    }, 0);
    
    $def(self, '$const_defined?', function $Module_const_defined$ques$9(name, inherit) {
      var self = this;

      
      
      if (inherit == null) inherit = true;;
      name = $$('Opal')['$const_name!'](name);
      if (!$truthy(name['$=~']($$$($Opal, 'CONST_NAME_REGEXP')))) {
        $Kernel.$raise($$$('NameError').$new("wrong constant name " + (name), name))
      };
      
      var module, modules = [self], module_constants, i, ii;

      // Add up ancestors if inherit is true
      if (inherit) {
        modules = modules.concat(Opal.ancestors(self));

        // Add Object's ancestors if it's a module – modules have no ancestors otherwise
        if (self.$$is_module) {
          modules = modules.concat([$Object]).concat(Opal.ancestors($Object));
        }
      }

      for (i = 0, ii = modules.length; i < ii; i++) {
        module = modules[i];
        if (module.$$const[name] != null) { return true; }
        if (
          module.$$autoload &&
          module.$$autoload[name] &&
          !module.$$autoload[name].required &&
          !module.$$autoload[name].success
        ) {
          return true;
        }
      }

      return false;
    ;
    }, -2);
    
    $def(self, '$const_get', function $$const_get(name, inherit) {
      var self = this;

      
      
      if (inherit == null) inherit = true;;
      name = $$('Opal')['$const_name!'](name);
      
      if (name.indexOf('::') === 0 && name !== '::'){
        name = name.slice(2);
      }
    ;
      if ($truthy(name.indexOf('::') != -1 && name != '::')) {
        return $send(name.$split("::"), 'inject', [self], function $$10(o, c){
          
          
          if (o == null) o = nil;;
          
          if (c == null) c = nil;;
          return o.$const_get(c);}, 2)
      };
      if (!$truthy(name['$=~']($$$($Opal, 'CONST_NAME_REGEXP')))) {
        $Kernel.$raise($$$('NameError').$new("wrong constant name " + (name), name))
      };
      
      if (inherit) {
        return Opal.$$([self], name);
      } else {
        return Opal.const_get_local(self, name);
      }
    ;
    }, -2);
    
    $def(self, '$const_missing', function $$const_missing(name) {
      var self = this, full_const_name = nil;

      
      full_const_name = ($eqeq(self, $Object) ? (name) : ("" + (self) + "::" + (name)));
      return $Kernel.$raise($$$('NameError').$new("uninitialized constant " + (full_const_name), name));
    }, 1);
    
    $def(self, '$const_set', function $$const_set(name, value) {
      var self = this;

      
      name = $Opal['$const_name!'](name);
      if (($truthy(name['$!~']($$$($Opal, 'CONST_NAME_REGEXP'))) || ($truthy(name['$start_with?']("::"))))) {
        $Kernel.$raise($$$('NameError').$new("wrong constant name " + (name), name))
      };
      $const_set(self, name, value);
      return value;
    }, 2);
    
    $def(self, '$public_constant', $return_val(nil), 0);
    
    $def(self, '$define_method', function $$define_method(name, method) {
      var block = $$define_method.$$p || nil, self = this, $ret_or_1 = nil, $ret_or_2 = nil;

      delete $$define_method.$$p;
      
      ;
      ;
      
      if (method === undefined && block === nil)
        $Kernel.$raise($$$('ArgumentError'), "tried to create a Proc object without a block")
    ;
      block = ($truthy(($ret_or_1 = block)) ? ($ret_or_1) : ($eqeqeq($$$('Proc'), ($ret_or_2 = method)) ? (method) : ($eqeqeq($$$('Method'), $ret_or_2) ? (method.$to_proc().$$unbound) : ($eqeqeq($$$('UnboundMethod'), $ret_or_2) ? ($lambda(function $$11($a){var $post_args, args, self = $$11.$$s == null ? this : $$11.$$s, bound = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        bound = method.$bind(self);
        return $send(bound, 'call', $to_a(args));}, {$$arity: -1, $$s: self})) : ($Kernel.$raise($$$('TypeError'), "wrong argument type " + (block.$class()) + " (expected Proc/Method)"))))));
      
      if (typeof(Proxy) !== 'undefined') {
        var meta = Object.create(null)

        block.$$proxy_target = block
        block = new Proxy(block, {
          apply: function(target, self, args) {
            var old_name = target.$$jsid
            target.$$jsid = name;
            try {
              return target.apply(self, args);
            } finally {
              target.$$jsid = old_name
            }
          }
        })
      }

      block.$$jsid        = name;
      block.$$s           = null;
      block.$$def         = block;
      block.$$define_meth = true;

      return Opal.defn(self, '$' + name, block);
    ;
    }, -2);
    
    $def(self, '$remove_method', function $$remove_method($a) {
      var $post_args, names, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      names = $post_args;;
      
      for (var i = 0, length = names.length; i < length; i++) {
        Opal.rdef(self, "$" + names[i]);
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$singleton_class?', function $Module_singleton_class$ques$12() {
      var self = this;

      return !!self.$$is_singleton;
    }, 0);
    
    $def(self, '$include', function $$include($a) {
      var $post_args, mods, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      mods = $post_args;;
      
      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (!mod.$$is_module) {
          $Kernel.$raise($$$('TypeError'), "wrong argument type " + ((mod).$class()) + " (expected Module)");
        }

        (mod).$append_features(self);
        (mod).$included(self);
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$included_modules', function $$included_modules() {
      var self = this;

      return Opal.included_modules(self);
    }, 0);
    
    $def(self, '$include?', function $Module_include$ques$13(mod) {
      var self = this;

      
      if (!mod.$$is_module) {
        $Kernel.$raise($$$('TypeError'), "wrong argument type " + ((mod).$class()) + " (expected Module)");
      }

      var i, ii, mod2, ancestors = Opal.ancestors(self);

      for (i = 0, ii = ancestors.length; i < ii; i++) {
        mod2 = ancestors[i];
        if (mod2 === mod && mod2 !== self) {
          return true;
        }
      }

      return false;
    
    }, 1);
    
    $def(self, '$instance_method', function $$instance_method(name) {
      var self = this;

      
      var meth = self.$$prototype['$' + name];

      if (!meth || meth.$$stub) {
        $Kernel.$raise($$$('NameError').$new("undefined method `" + (name) + "' for class `" + (self.$name()) + "'", name));
      }

      return $$$('UnboundMethod').$new(self, meth.$$owner || self, meth, name);
    
    }, 1);
    
    $def(self, '$instance_methods', function $$instance_methods(include_super) {
      var self = this;

      
      
      if (include_super == null) include_super = true;;
      
      if ($truthy(include_super)) {
        return Opal.instance_methods(self);
      } else {
        return Opal.own_instance_methods(self);
      }
    ;
    }, -1);
    
    $def(self, '$included', $return_val(nil), 0);
    
    $def(self, '$extended', $return_val(nil), 0);
    
    $def(self, '$extend_object', $return_val(nil), 0);
    
    $def(self, '$method_added', function $$method_added($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    
    $def(self, '$method_removed', function $$method_removed($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    
    $def(self, '$method_undefined', function $$method_undefined($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    
    $def(self, '$module_eval', function $$module_eval($a) {
      var block = $$module_eval.$$p || nil, $post_args, args, $b, self = this, string = nil, file = nil, _lineno = nil, default_eval_options = nil, $ret_or_1 = nil, compiling_options = nil, compiled = nil;

      delete $$module_eval.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if (($truthy(block['$nil?']()) && ($truthy(!!Opal.compile)))) {
        
        if (!$truthy($range(1, 3, false)['$cover?'](args.$size()))) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        };
        $b = [].concat($to_a(args)), (string = ($b[0] == null ? nil : $b[0])), (file = ($b[1] == null ? nil : $b[1])), (_lineno = ($b[2] == null ? nil : $b[2])), $b;
        default_eval_options = $hash2(["file", "eval"], {"file": ($truthy(($ret_or_1 = file)) ? ($ret_or_1) : ("(eval)")), "eval": true});
        compiling_options = Opal.hash({ arity_check: false }).$merge(default_eval_options);
        compiled = $Opal.$compile(string, compiling_options);
        block = $send($Kernel, 'proc', [], function $$14(){var self = $$14.$$s == null ? this : $$14.$$s;

          return new Function("Opal,self", "return " + compiled)(Opal, self);}, {$$arity: 0, $$s: self});
      } else if ($truthy(args['$any?']())) {
        $Kernel.$raise($$$('ArgumentError'), "" + ("wrong number of arguments (" + (args.$size()) + " for 0)") + "\n\n  NOTE:If you want to enable passing a String argument please add \"require 'opal-parser'\" to your script\n")
      };
      
      var old = block.$$s,
          result;

      block.$$s = null;
      result = block.apply(self, [self]);
      block.$$s = old;

      return result;
    ;
    }, -1);
    
    $def(self, '$module_exec', function $$module_exec($a) {
      var block = $$module_exec.$$p || nil, $post_args, args, self = this;

      delete $$module_exec.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      if (block === nil) {
        $Kernel.$raise($$$('LocalJumpError'), "no block given")
      }

      var block_self = block.$$s, result;

      block.$$s = null;
      result = block.apply(self, args);
      block.$$s = block_self;

      return result;
    ;
    }, -1);
    
    $def(self, '$method_defined?', function $Module_method_defined$ques$15(method) {
      var self = this;

      
      var body = self.$$prototype['$' + method];
      return (!!body) && !body.$$stub;
    
    }, 1);
    
    $def(self, '$module_function', function $$module_function($a) {
      var $post_args, methods, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      methods = $post_args;;
      
      if (methods.length === 0) {
        self.$$module_function = true;
        return nil;
      }
      else {
        for (var i = 0, length = methods.length; i < length; i++) {
          var meth = methods[i],
              id   = '$' + meth,
              func = self.$$prototype[id];

          Opal.defs(self, id, func);
        }
        return methods.length === 1 ? methods[0] : methods;
      }

      return self;
    ;
    }, -1);
    
    $def(self, '$name', function $$name() {
      var self = this;

      
      if (self.$$full_name) {
        return self.$$full_name;
      }

      var result = [], base = self;

      while (base) {
        // Give up if any of the ancestors is unnamed
        if (base.$$name === nil || base.$$name == null) return nil;

        result.unshift(base.$$name);

        base = base.$$base_module;

        if (base === $Object) {
          break;
        }
      }

      if (result.length === 0) {
        return nil;
      }

      return self.$$full_name = result.join('::');
    
    }, 0);
    
    $def(self, '$prepend', function $$prepend($a) {
      var $post_args, mods, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      mods = $post_args;;
      
      if (mods.length === 0) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (given 0, expected 1+)")
      }

      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (!mod.$$is_module) {
          $Kernel.$raise($$$('TypeError'), "wrong argument type " + ((mod).$class()) + " (expected Module)");
        }

        (mod).$prepend_features(self);
        (mod).$prepended(self);
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$prepend_features', function $$prepend_features(prepender) {
      var self = this;

      
      
      if (!self.$$is_module) {
        $Kernel.$raise($$$('TypeError'), "wrong argument type " + (self.$class()) + " (expected Module)");
      }

      Opal.prepend_features(self, prepender)
    ;
      return self;
    }, 1);
    
    $def(self, '$prepended', $return_val(nil), 0);
    
    $def(self, '$remove_const', function $$remove_const(name) {
      var self = this;

      return Opal.const_remove(self, name);
    }, 1);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = Opal.Module.$name.call(self)))) {
        return $ret_or_1
      } else {
        return "#<" + (self.$$is_module ? 'Module' : 'Class') + ":0x" + (self.$__id__().$to_s(16)) + ">"
      }
    }, 0);
    
    $def(self, '$undef_method', function $$undef_method($a) {
      var $post_args, names, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      names = $post_args;;
      
      for (var i = 0, length = names.length; i < length; i++) {
        Opal.udef(self, "$" + names[i]);
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$instance_variables', function $$instance_variables() {
      var self = this, consts = nil;

      
      consts = (Opal.Module.$$nesting = $nesting, self.$constants());
      
      var result = [];

      for (var name in self) {
        if (self.hasOwnProperty(name) && name.charAt(0) !== '$' && name !== 'constructor' && !consts['$include?'](name)) {
          result.push('@' + name);
        }
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$dup', function $$dup() {
      var $yield = $$dup.$$p || nil, self = this, copy = nil;

      delete $$dup.$$p;
      
      copy = $send2(self, $find_super(self, 'dup', $$dup, false, true), 'dup', [], $yield);
      copy.$copy_class_variables(self);
      copy.$copy_constants(self);
      return copy;
    }, 0);
    
    $def(self, '$copy_class_variables', function $$copy_class_variables(other) {
      var self = this;

      
      for (var name in other.$$cvars) {
        self.$$cvars[name] = other.$$cvars[name];
      }
    
    }, 1);
    
    $def(self, '$copy_constants', function $$copy_constants(other) {
      var self = this;

      
      var name, other_constants = other.$$const;

      for (name in other_constants) {
        $const_set(self, name, other_constants[name]);
      }
    
    }, 1);
    
    $def(self, '$refine', function $$refine(klass) {
      var block = $$refine.$$p || nil, $a, self = this, refinement_module = nil, m = nil, klass_id = nil;

      delete $$refine.$$p;
      
      ;
      $a = [self, nil, nil], (refinement_module = $a[0]), (m = $a[1]), (klass_id = $a[2]), $a;
      
      klass_id = Opal.id(klass);
      if (typeof self.$$refine_modules === "undefined") {
        self.$$refine_modules = {};
      }
      if (typeof self.$$refine_modules[klass_id] === "undefined") {
        m = self.$$refine_modules[klass_id] = $$$('Refinement').$new();
      }
      else {
        m = self.$$refine_modules[klass_id];
      }
      m.refinement_module = refinement_module
      m.refined_class = klass
    ;
      $send(m, 'class_exec', [], block.$to_proc());
      return m;
    }, 1);
    
    $def(self, '$using', function $$using(mod) {
      
      return $Kernel.$raise("Module#using is not permitted in methods")
    }, 1);
    $alias(self, "class_eval", "module_eval");
    $alias(self, "class_exec", "module_exec");
    return $alias(self, "inspect", "to_s");
  })('::', null, $nesting);
  return (function($base, $super) {
    var self = $klass($base, $super, 'Refinement');

    var $proto = self.$$prototype;

    $proto.refinement_module = $proto.refined_class = nil;
    return $def(self, '$inspect', function $$inspect() {
      var $yield = $$inspect.$$p || nil, self = this;

      delete $$inspect.$$p;
      if ($truthy(self.refinement_module)) {
        return "#<refinement:" + (self.refined_class.$inspect()) + "@" + (self.refinement_module.$inspect()) + ">"
      } else {
        return $send2(self, $find_super(self, 'inspect', $$inspect, false, true), 'inspect', [], $yield)
      }
    }, 0)
  })('::', $Module);
};

Opal.modules["corelib/class"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $klass = Opal.klass, $send = Opal.send, $defs = Opal.defs, $def = Opal.def, $rb_plus = Opal.rb_plus, $return_val = Opal.return_val, $send2 = Opal.send2, $find_super = Opal.find_super, $alias = Opal.alias;

  Opal.add_stubs('require,class_eval,to_proc,+,subclasses,flatten,map,initialize_copy,allocate,name,to_s');
  
  self.$require("corelib/module");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Class');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    $defs(self, '$new', function $Class_new$1(superclass) {
      var block = $Class_new$1.$$p || nil;

      delete $Class_new$1.$$p;
      
      ;
      
      if (superclass == null) superclass = $$('Object');;
      
      if (!superclass.$$is_class) {
        throw Opal.TypeError.$new("superclass must be a Class");
      }

      var klass = Opal.allocate_class(nil, superclass);
      superclass.$inherited(klass);
      ((block !== nil) ? ($send((klass), 'class_eval', [], block.$to_proc())) : nil)
      return klass;
    ;
    }, -1);
    
    $def(self, '$allocate', function $$allocate() {
      var self = this;

      
      var obj = new self.$$constructor();
      obj.$$id = Opal.uid();
      return obj;
    
    }, 0);
    
    $def(self, '$descendants', function $$descendants() {
      var self = this;

      return $rb_plus(self.$subclasses(), $send(self.$subclasses(), 'map', [], "descendants".$to_proc()).$flatten())
    }, 0);
    
    $def(self, '$inherited', $return_val(nil), 0);
    
    $def(self, '$initialize_dup', function $$initialize_dup(original) {
      var self = this;

      
      self.$initialize_copy(original);
      
      self.$$name = null;
      self.$$full_name = null;
    ;
    }, 1);
    
    $def(self, '$new', function $Class_new$2($a) {
      var block = $Class_new$2.$$p || nil, $post_args, args, self = this;

      delete $Class_new$2.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var object = self.$allocate();
      Opal.send(object, object.$initialize, args, block);
      return object;
    ;
    }, -1);
    
    $def(self, '$subclasses', function $$subclasses() {
      var self = this;

      
      if (typeof WeakRef !== 'undefined') {
        var i, subclass, out = [];
        for (i = 0; i < self.$$subclasses.length; i++) {
          subclass = self.$$subclasses[i].deref();
          if (subclass !== undefined) {
            out.push(subclass);
          }
        }
        return out;
      }
      else {
        return self.$$subclasses;
      }
    
    }, 0);
    
    $def(self, '$superclass', function $$superclass() {
      var self = this;

      return self.$$super || nil;
    }, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var $yield = $$to_s.$$p || nil, self = this;

      delete $$to_s.$$p;
      
      var singleton_of = self.$$singleton_of;

      if (singleton_of && singleton_of.$$is_a_module) {
        return "#<Class:" + ((singleton_of).$name()) + ">";
      }
      else if (singleton_of) {
        // a singleton class created from an object
        return "#<Class:#<" + ((singleton_of.$$class).$name()) + ":0x" + ((Opal.id(singleton_of)).$to_s(16)) + ">>";
      }

      return $send2(self, $find_super(self, 'to_s', $$to_s, false, true), 'to_s', [], null);
    
    }, 0);
    return $alias(self, "inspect", "to_s");
  })('::', null, $nesting);
};

Opal.modules["corelib/basic_object"] = function(Opal) {/* Generated by Opal 1.5.1 */
  "use strict";
  var nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $def = Opal.def, $alias = Opal.alias, $return_val = Opal.return_val, $truthy = Opal.truthy, $range = Opal.range, $Kernel = Opal.Kernel, $to_a = Opal.to_a, $hash2 = Opal.hash2, $Opal = Opal.Opal, $send = Opal.send, $eqeq = Opal.eqeq, $rb_ge = Opal.rb_ge;

  Opal.add_stubs('==,raise,inspect,!,nil?,cover?,size,merge,compile,proc,[],first,>=,length,instance_variable_get,any?,new,caller,pristine');
  return (function($base, $super) {
    var self = $klass($base, $super, 'BasicObject');

    
    
    
    $def(self, '$initialize', function $$initialize($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    
    $def(self, '$==', function $BasicObject_$eq_eq$1(other) {
      var self = this;

      return self === other;
    }, 1);
    
    $def(self, '$eql?', function $BasicObject_eql$ques$2(other) {
      var self = this;

      return self['$=='](other)
    }, 1);
    $alias(self, "equal?", "==");
    
    $def(self, '$__id__', function $$__id__() {
      var self = this;

      
      if (self.$$id != null) {
        return self.$$id;
      }
      Opal.prop(self, '$$id', Opal.uid());
      return self.$$id;
    
    }, 0);
    
    $def(self, '$__send__', function $$__send__(symbol, $a) {
      var block = $$__send__.$$p || nil, $post_args, args, self = this;

      delete $$__send__.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      
      if (!symbol.$$is_string) {
        self.$raise($$$('TypeError'), "" + (self.$inspect()) + " is not a symbol nor a string")
      }

      var func = self['$' + symbol];

      if (func) {
        if (block !== nil) {
          func.$$p = block;
        }

        return func.apply(self, args);
      }

      if (block !== nil) {
        self.$method_missing.$$p = block;
      }

      return self.$method_missing.apply(self, [symbol].concat(args));
    ;
    }, -2);
    
    $def(self, '$!', $return_val(false), 0);
    
    $def(self, '$!=', function $BasicObject_$not_eq$3(other) {
      var self = this;

      return self['$=='](other)['$!']()
    }, 1);
    
    $def(self, '$instance_eval', function $$instance_eval($a) {
      var block = $$instance_eval.$$p || nil, $post_args, args, $b, self = this, string = nil, file = nil, _lineno = nil, default_eval_options = nil, $ret_or_1 = nil, compiling_options = nil, compiled = nil;

      delete $$instance_eval.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if (($truthy(block['$nil?']()) && ($truthy(!!Opal.compile)))) {
        
        if (!$truthy($range(1, 3, false)['$cover?'](args.$size()))) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        };
        $b = [].concat($to_a(args)), (string = ($b[0] == null ? nil : $b[0])), (file = ($b[1] == null ? nil : $b[1])), (_lineno = ($b[2] == null ? nil : $b[2])), $b;
        default_eval_options = $hash2(["file", "eval"], {"file": ($truthy(($ret_or_1 = file)) ? ($ret_or_1) : ("(eval)")), "eval": true});
        compiling_options = Opal.hash({ arity_check: false }).$merge(default_eval_options);
        compiled = $Opal.$compile(string, compiling_options);
        block = $send($Kernel, 'proc', [], function $$4(){var self = $$4.$$s == null ? this : $$4.$$s;

          return new Function("Opal,self", "return " + compiled)(Opal, self);}, {$$arity: 0, $$s: self});
      } else if ((($truthy(block['$nil?']()) && ($truthy($rb_ge(args.$length(), 1)))) && ($eqeq(args.$first()['$[]'](0), "@")))) {
        return self.$instance_variable_get(args.$first())
      } else if ($truthy(args['$any?']())) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (args.$size()) + " for 0)")
      };
      
      var old = block.$$s,
          result;

      block.$$s = null;

      // Need to pass $$eval so that method definitions know if this is
      // being done on a class/module. Cannot be compiler driven since
      // send(:instance_eval) needs to work.
      if (self.$$is_a_module) {
        self.$$eval = true;
        try {
          result = block.call(self, self);
        }
        finally {
          self.$$eval = false;
        }
      }
      else {
        result = block.call(self, self);
      }

      block.$$s = old;

      return result;
    ;
    }, -1);
    
    $def(self, '$instance_exec', function $$instance_exec($a) {
      var block = $$instance_exec.$$p || nil, $post_args, args, self = this;

      delete $$instance_exec.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if (!$truthy(block)) {
        $Kernel.$raise($$$('ArgumentError'), "no block given")
      };
      
      var block_self = block.$$s,
          result;

      block.$$s = null;

      if (self.$$is_a_module) {
        self.$$eval = true;
        try {
          result = block.apply(self, args);
        }
        finally {
          self.$$eval = false;
        }
      }
      else {
        result = block.apply(self, args);
      }

      block.$$s = block_self;

      return result;
    ;
    }, -1);
    
    $def(self, '$singleton_method_added', function $$singleton_method_added($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    
    $def(self, '$singleton_method_removed', function $$singleton_method_removed($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    
    $def(self, '$singleton_method_undefined', function $$singleton_method_undefined($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    
    $def(self, '$method_missing', function $$method_missing(symbol, $a) {
      var block = $$method_missing.$$p || nil, $post_args, args, self = this, inspect_result = nil;

      delete $$method_missing.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      inspect_result = $Opal.$inspect(self);
      return $Kernel.$raise($$$('NoMethodError').$new("undefined method `" + (symbol) + "' for " + (inspect_result), symbol, args), nil, $Kernel.$caller(1));
    }, -2);
    $Opal.$pristine(self, "method_missing");
    return $def(self, '$respond_to_missing?', function $BasicObject_respond_to_missing$ques$5(method_name, include_all) {
      
      
      
      if (include_all == null) include_all = false;;
      return false;
    }, -2);
  })('::', null)
};

Opal.modules["corelib/kernel"] = function(Opal) {/* Generated by Opal 1.5.1 */
  "use strict";
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $coerce_to = Opal.coerce_to, $respond_to = Opal.respond_to, $Opal = Opal.Opal, $module = Opal.module, $return_val = Opal.return_val, $def = Opal.def, $Kernel = Opal.Kernel, $gvars = Opal.gvars, $hash2 = Opal.hash2, $send = Opal.send, $to_a = Opal.to_a, $rb_plus = Opal.rb_plus, $eqeq = Opal.eqeq, $eqeqeq = Opal.eqeqeq, $return_self = Opal.return_self, $rb_le = Opal.rb_le, $rb_lt = Opal.rb_lt, $Object = Opal.Object, $alias = Opal.alias, $klass = Opal.klass;

  Opal.add_stubs('!,=~,==,object_id,raise,new,class,coerce_to?,<<,allocate,copy_instance_variables,copy_singleton_methods,initialize_clone,initialize_copy,define_method,singleton_class,to_proc,initialize_dup,for,empty?,pop,call,append_features,extend_object,extended,gets,__id__,include?,each,instance_variables,instance_variable_get,inspect,+,to_s,instance_variable_name!,respond_to?,to_int,coerce_to!,Integer,nil?,===,enum_for,result,any?,print,format,puts,<=,length,[],readline,<,first,split,caller,map,to_str,exception,backtrace,rand,respond_to_missing?,pristine,try_convert!,expand_path,join,start_with?,new_seed,srand,tag,value,open,is_a?,__send__,yield_self,include');
  
  (function($base, $parent_nesting) {
    var self = $module($base, 'Kernel');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    
    $def(self, '$=~', $return_val(false), 0);
    
    $def(self, '$!~', function $Kernel_$excl_tilde$1(obj) {
      var self = this;

      return self['$=~'](obj)['$!']()
    }, 1);
    
    $def(self, '$===', function $Kernel_$eq_eq_eq$2(other) {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.$object_id()['$=='](other.$object_id())))) {
        return $ret_or_1
      } else {
        return self['$=='](other)
      }
    }, 1);
    
    $def(self, '$<=>', function $Kernel_$lt_eq_gt$3(other) {
      var self = this;

      
      // set guard for infinite recursion
      self.$$comparable = true;

      var x = self['$=='](other);

      if (x && x !== nil) {
        return 0;
      }

      return nil;
    
    }, 1);
    
    $def(self, '$method', function $$method(name) {
      var self = this;

      
      var meth = self['$' + name];

      if (!meth || meth.$$stub) {
        $Kernel.$raise($$$('NameError').$new("undefined method `" + (name) + "' for class `" + (self.$class()) + "'", name));
      }

      return $$$('Method').$new(self, meth.$$owner || self.$class(), meth, name);
    
    }, 1);
    
    $def(self, '$methods', function $$methods(all) {
      var self = this;

      
      
      if (all == null) all = true;;
      
      if ($truthy(all)) {
        return Opal.methods(self);
      } else {
        return Opal.own_methods(self);
      }
    ;
    }, -1);
    
    $def(self, '$public_methods', function $$public_methods(all) {
      var self = this;

      
      
      if (all == null) all = true;;
      
      if ($truthy(all)) {
        return Opal.methods(self);
      } else {
        return Opal.receiver_methods(self);
      }
    ;
    }, -1);
    
    $def(self, '$Array', function $$Array(object) {
      
      
      var coerced;

      if (object === nil) {
        return [];
      }

      if (object.$$is_array) {
        return object;
      }

      coerced = $Opal['$coerce_to?'](object, $$$('Array'), "to_ary");
      if (coerced !== nil) { return coerced; }

      coerced = $Opal['$coerce_to?'](object, $$$('Array'), "to_a");
      if (coerced !== nil) { return coerced; }

      return [object];
    
    }, 1);
    
    $def(self, '$at_exit', function $$at_exit() {
      var block = $$at_exit.$$p || nil, $ret_or_1 = nil;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      delete $$at_exit.$$p;
      
      ;
      $gvars.__at_exit__ = ($truthy(($ret_or_1 = $gvars.__at_exit__)) ? ($ret_or_1) : ([]));
      $gvars.__at_exit__['$<<'](block);
      return block;
    }, 0);
    
    $def(self, '$caller', function $$caller(start, length) {
      
      
      
      if (start == null) start = 1;;
      
      if (length == null) length = nil;;
      
      var stack, result;

      stack = new Error().$backtrace();
      result = [];

      for (var i = start + 1, ii = stack.length; i < ii; i++) {
        if (!stack[i].match(/runtime\.js/)) {
          result.push(stack[i]);
        }
      }
      if (length != nil) result = result.slice(0, length);
      return result;
    ;
    }, -1);
    
    $def(self, '$class', function $Kernel_class$4() {
      var self = this;

      return self.$$class;
    }, 0);
    
    $def(self, '$copy_instance_variables', function $$copy_instance_variables(other) {
      var self = this;

      
      var keys = Object.keys(other), i, ii, name;
      for (i = 0, ii = keys.length; i < ii; i++) {
        name = keys[i];
        if (name.charAt(0) !== '$' && other.hasOwnProperty(name)) {
          self[name] = other[name];
        }
      }
    
    }, 1);
    
    $def(self, '$copy_singleton_methods', function $$copy_singleton_methods(other) {
      var self = this;

      
      var i, name, names, length;

      if (other.hasOwnProperty('$$meta')) {
        var other_singleton_class = Opal.get_singleton_class(other);
        var self_singleton_class = Opal.get_singleton_class(self);
        names = Object.getOwnPropertyNames(other_singleton_class.$$prototype);

        for (i = 0, length = names.length; i < length; i++) {
          name = names[i];
          if (Opal.is_method(name)) {
            self_singleton_class.$$prototype[name] = other_singleton_class.$$prototype[name];
          }
        }

        self_singleton_class.$$const = Object.assign({}, other_singleton_class.$$const);
        Object.setPrototypeOf(
          self_singleton_class.$$prototype,
          Object.getPrototypeOf(other_singleton_class.$$prototype)
        );
      }

      for (i = 0, names = Object.getOwnPropertyNames(other), length = names.length; i < length; i++) {
        name = names[i];
        if (name.charAt(0) === '$' && name.charAt(1) !== '$' && other.hasOwnProperty(name)) {
          self[name] = other[name];
        }
      }
    
    }, 1);
    
    $def(self, '$clone', function $$clone($kwargs) {
      var freeze, self = this, copy = nil;

      
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      freeze = $kwargs.$$smap["freeze"];
      if (freeze == null) freeze = true;
      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$copy_singleton_methods(self);
      copy.$initialize_clone(self);
      return copy;
    }, -1);
    
    $def(self, '$initialize_clone', function $$initialize_clone(other) {
      var self = this;

      return self.$initialize_copy(other)
    }, 1);
    
    $def(self, '$define_singleton_method', function $$define_singleton_method(name, method) {
      var block = $$define_singleton_method.$$p || nil, self = this;

      delete $$define_singleton_method.$$p;
      
      ;
      ;
      return $send(self.$singleton_class(), 'define_method', [name, method], block.$to_proc());
    }, -2);
    
    $def(self, '$dup', function $$dup() {
      var self = this, copy = nil;

      
      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    }, 0);
    
    $def(self, '$initialize_dup', function $$initialize_dup(other) {
      var self = this;

      return self.$initialize_copy(other)
    }, 1);
    
    $def(self, '$enum_for', function $$enum_for($a, $b) {
      var block = $$enum_for.$$p || nil, $post_args, method, args, self = this;

      delete $$enum_for.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      if ($post_args.length > 0) method = $post_args.shift();
      if (method == null) method = "each";;
      
      args = $post_args;;
      return $send($$$('Enumerator'), 'for', [self, method].concat($to_a(args)), block.$to_proc());
    }, -1);
    
    $def(self, '$equal?', function $Kernel_equal$ques$5(other) {
      var self = this;

      return self === other;
    }, 1);
    
    $def(self, '$exit', function $$exit(status) {
      var $a, $ret_or_1 = nil, block = nil;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      
      
      if (status == null) status = true;;
      $gvars.__at_exit__ = ($truthy(($ret_or_1 = $gvars.__at_exit__)) ? ($ret_or_1) : ([]));
      while (!($truthy($gvars.__at_exit__['$empty?']()))) {
        
        block = $gvars.__at_exit__.$pop();
        block.$call();
      };
      
      if (status.$$is_boolean) {
        status = status ? 0 : 1;
      } else {
        status = $coerce_to(status, $$$('Integer'), 'to_int')
      }

      Opal.exit(status);
    ;
      return nil;
    }, -1);
    
    $def(self, '$extend', function $$extend($a) {
      var $post_args, mods, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      mods = $post_args;;
      
      var singleton = self.$singleton_class();

      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (!mod.$$is_module) {
          $Kernel.$raise($$$('TypeError'), "wrong argument type " + ((mod).$class()) + " (expected Module)");
        }

        (mod).$append_features(singleton);
        (mod).$extend_object(self);
        (mod).$extended(self);
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$gets', function $$gets($a) {
      var $post_args, args;
      if ($gvars.stdin == null) $gvars.stdin = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return $send($gvars.stdin, 'gets', $to_a(args));
    }, -1);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      return self.$__id__()
    }, 0);
    
    $def(self, '$initialize_copy', $return_val(nil), 0);
    var inspect_stack = [];
    
    $def(self, '$inspect', function $$inspect() {
      var self = this, ivs = nil, id = nil, pushed = nil, e = nil;

      return (function() { try {
      try {
        
        ivs = "";
        id = self.$__id__();
        if ($truthy((inspect_stack)['$include?'](id))) {
          ivs = " ..."
        } else {
          
          (inspect_stack)['$<<'](id);
          pushed = true;
          $send(self.$instance_variables(), 'each', [], function $$6(i){var self = $$6.$$s == null ? this : $$6.$$s, ivar = nil, inspect = nil;

            
            
            if (i == null) i = nil;;
            ivar = self.$instance_variable_get(i);
            inspect = $$('Opal').$inspect(ivar);
            return (ivs = $rb_plus(ivs, " " + (i) + "=" + (inspect)));}, {$$arity: 1, $$s: self});
        };
        return "#<" + (self.$class()) + ":0x" + (id.$to_s(16)) + (ivs) + ">";
      } catch ($err) {
        if (Opal.rescue($err, [$$('StandardError')])) {(e = $err)
          try {
            return "#<" + (self.$class()) + ":0x" + (id.$to_s(16)) + ">"
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      }
      } finally {
        ($truthy(pushed) ? ((inspect_stack).$pop()) : nil)
      }; })()
    }, 0);
    
    $def(self, '$instance_of?', function $Kernel_instance_of$ques$7(klass) {
      var self = this;

      
      if (!klass.$$is_class && !klass.$$is_module) {
        $Kernel.$raise($$$('TypeError'), "class or module required");
      }

      return self.$$class === klass;
    
    }, 1);
    
    $def(self, '$instance_variable_defined?', function $Kernel_instance_variable_defined$ques$8(name) {
      var self = this;

      
      name = $Opal['$instance_variable_name!'](name);
      return Opal.hasOwnProperty.call(self, name.substr(1));;
    }, 1);
    
    $def(self, '$instance_variable_get', function $$instance_variable_get(name) {
      var self = this;

      
      name = $Opal['$instance_variable_name!'](name);
      
      var ivar = self[Opal.ivar(name.substr(1))];

      return ivar == null ? nil : ivar;
    ;
    }, 1);
    
    $def(self, '$instance_variable_set', function $$instance_variable_set(name, value) {
      var self = this;

      
      name = $Opal['$instance_variable_name!'](name);
      return self[Opal.ivar(name.substr(1))] = value;;
    }, 2);
    
    $def(self, '$remove_instance_variable', function $$remove_instance_variable(name) {
      var self = this;

      
      name = $Opal['$instance_variable_name!'](name);
      
      var key = Opal.ivar(name.substr(1)),
          val;
      if (self.hasOwnProperty(key)) {
        val = self[key];
        delete self[key];
        return val;
      }
    ;
      return $Kernel.$raise($$$('NameError'), "instance variable " + (name) + " not defined");
    }, 1);
    
    $def(self, '$instance_variables', function $$instance_variables() {
      var self = this;

      
      var result = [], ivar;

      for (var name in self) {
        if (self.hasOwnProperty(name) && name.charAt(0) !== '$') {
          if (name.substr(-1) === '$') {
            ivar = name.slice(0, name.length - 1);
          } else {
            ivar = name;
          }
          result.push('@' + ivar);
        }
      }

      return result;
    
    }, 0);
    
    $def(self, '$Integer', function $$Integer(value, base) {
      
      
      ;
      
      var i, str, base_digits;

      if (!value.$$is_string) {
        if (base !== undefined) {
          $Kernel.$raise($$$('ArgumentError'), "base specified for non string value")
        }
        if (value === nil) {
          $Kernel.$raise($$$('TypeError'), "can't convert nil into Integer")
        }
        if (value.$$is_number) {
          if (value === Infinity || value === -Infinity || isNaN(value)) {
            $Kernel.$raise($$$('FloatDomainError'), value)
          }
          return Math.floor(value);
        }
        if (value['$respond_to?']("to_int")) {
          i = value.$to_int();
          if (i !== nil) {
            return i;
          }
        }
        return $Opal['$coerce_to!'](value, $$$('Integer'), "to_i");
      }

      if (value === "0") {
        return 0;
      }

      if (base === undefined) {
        base = 0;
      } else {
        base = $coerce_to(base, $$$('Integer'), 'to_int');
        if (base === 1 || base < 0 || base > 36) {
          $Kernel.$raise($$$('ArgumentError'), "invalid radix " + (base))
        }
      }

      str = value.toLowerCase();

      str = str.replace(/(\d)_(?=\d)/g, '$1');

      str = str.replace(/^(\s*[+-]?)(0[bodx]?)/, function (_, head, flag) {
        switch (flag) {
        case '0b':
          if (base === 0 || base === 2) {
            base = 2;
            return head;
          }
          // no-break
        case '0':
        case '0o':
          if (base === 0 || base === 8) {
            base = 8;
            return head;
          }
          // no-break
        case '0d':
          if (base === 0 || base === 10) {
            base = 10;
            return head;
          }
          // no-break
        case '0x':
          if (base === 0 || base === 16) {
            base = 16;
            return head;
          }
          // no-break
        }
        $Kernel.$raise($$$('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      });

      base = (base === 0 ? 10 : base);

      base_digits = '0-' + (base <= 10 ? base - 1 : '9a-' + String.fromCharCode(97 + (base - 11)));

      if (!(new RegExp('^\\s*[+-]?[' + base_digits + ']+\\s*$')).test(str)) {
        $Kernel.$raise($$$('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      }

      i = parseInt(str, base);

      if (isNaN(i)) {
        $Kernel.$raise($$$('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      }

      return i;
    ;
    }, -2);
    
    $def(self, '$Float', function $$Float(value) {
      
      
      var str;

      if (value === nil) {
        $Kernel.$raise($$$('TypeError'), "can't convert nil into Float")
      }

      if (value.$$is_string) {
        str = value.toString();

        str = str.replace(/(\d)_(?=\d)/g, '$1');

        //Special case for hex strings only:
        if (/^\s*[-+]?0[xX][0-9a-fA-F]+\s*$/.test(str)) {
          return $Kernel.$Integer(str);
        }

        if (!/^\s*[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?\s*$/.test(str)) {
          $Kernel.$raise($$$('ArgumentError'), "invalid value for Float(): \"" + (value) + "\"")
        }

        return parseFloat(str);
      }

      return $Opal['$coerce_to!'](value, $$$('Float'), "to_f");
    
    }, 1);
    
    $def(self, '$Hash', function $$Hash(arg) {
      
      
      if (($truthy(arg['$nil?']()) || ($eqeq(arg, [])))) {
        return $hash2([], {})
      };
      if ($eqeqeq($$$('Hash'), arg)) {
        return arg
      };
      return $Opal['$coerce_to!'](arg, $$$('Hash'), "to_hash");
    }, 1);
    
    $def(self, '$is_a?', function $Kernel_is_a$ques$9(klass) {
      var self = this;

      
      if (!klass.$$is_class && !klass.$$is_module) {
        $Kernel.$raise($$$('TypeError'), "class or module required");
      }

      return Opal.is_a(self, klass);
    
    }, 1);
    
    $def(self, '$itself', $return_self, 0);
    
    $def(self, '$lambda', function $$lambda() {
      var block = $$lambda.$$p || nil;

      delete $$lambda.$$p;
      
      ;
      return Opal.lambda(block);;
    }, 0);
    
    $def(self, '$load', function $$load(file) {
      
      
      file = $Opal['$coerce_to!'](file, $$$('String'), "to_str");
      return Opal.load(file);
    }, 1);
    
    $def(self, '$loop', function $$loop() {
      var $a, $yield = $$loop.$$p || nil, self = this, e = nil;

      delete $$loop.$$p;
      
      if (!($yield !== nil)) {
        return $send(self, 'enum_for', ["loop"], function $$10(){
          return $$$($$$('Float'), 'INFINITY')}, 0)
      };
      while ($truthy(true)) {
        
        try {
          Opal.yieldX($yield, [])
        } catch ($err) {
          if (Opal.rescue($err, [$$$('StopIteration')])) {(e = $err)
            try {
              return e.$result()
            } finally { Opal.pop_exception(); }
          } else { throw $err; }
        };
      };
      return self;
    }, 0);
    
    $def(self, '$nil?', $return_val(false), 0);
    
    $def(self, '$printf', function $$printf($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if ($truthy(args['$any?']())) {
        self.$print($send(self, 'format', $to_a(args)))
      };
      return nil;
    }, -1);
    
    $def(self, '$proc', function $$proc() {
      var block = $$proc.$$p || nil;

      delete $$proc.$$p;
      
      ;
      if (!$truthy(block)) {
        $Kernel.$raise($$$('ArgumentError'), "tried to create Proc object without a block")
      };
      block.$$is_lambda = false;
      return block;
    }, 0);
    
    $def(self, '$puts', function $$puts($a) {
      var $post_args, strs;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      strs = $post_args;;
      return $send($gvars.stdout, 'puts', $to_a(strs));
    }, -1);
    
    $def(self, '$p', function $$p($a) {
      var $post_args, args;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      $send(args, 'each', [], function $$11(obj){        if ($gvars.stdout == null) $gvars.stdout = nil;

        
        
        if (obj == null) obj = nil;;
        return $gvars.stdout.$puts(obj.$inspect());}, 1);
      if ($truthy($rb_le(args.$length(), 1))) {
        return args['$[]'](0)
      } else {
        return args
      };
    }, -1);
    
    $def(self, '$print', function $$print($a) {
      var $post_args, strs;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      strs = $post_args;;
      return $send($gvars.stdout, 'print', $to_a(strs));
    }, -1);
    
    $def(self, '$readline', function $$readline($a) {
      var $post_args, args;
      if ($gvars.stdin == null) $gvars.stdin = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return $send($gvars.stdin, 'readline', $to_a(args));
    }, -1);
    
    $def(self, '$warn', function $$warn($a, $b) {
      var $post_args, $kwargs, strs, uplevel, $c, $d, $e, self = this, location = nil;
      if ($gvars.VERBOSE == null) $gvars.VERBOSE = nil;
      if ($gvars.stderr == null) $gvars.stderr = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $kwargs = Opal.extract_kwargs($post_args);
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      strs = $post_args;;
      
      uplevel = $kwargs.$$smap["uplevel"];
      if (uplevel == null) uplevel = nil;
      if ($truthy(uplevel)) {
        
        uplevel = $Opal['$coerce_to!'](uplevel, $$$('Integer'), "to_str");
        if ($truthy($rb_lt(uplevel, 0))) {
          $Kernel.$raise($$$('ArgumentError'), "negative level (" + (uplevel) + ")")
        };
        location = ($c = ($d = self.$caller($rb_plus(uplevel, 1), 1).$first(), ($d === nil || $d == null) ? nil : self.$caller($rb_plus(uplevel, 1), 1).$first().$split(":in `")), ($c === nil || $c == null) ? nil : ($e = self.$caller($rb_plus(uplevel, 1), 1).$first(), ($e === nil || $e == null) ? nil : self.$caller($rb_plus(uplevel, 1), 1).$first().$split(":in `")).$first());
        if ($truthy(location)) {
          location = "" + (location) + ": "
        };
        strs = $send(strs, 'map', [], function $$12(s){
          
          
          if (s == null) s = nil;;
          return "" + (location) + "warning: " + (s);}, 1);
      };
      if (($truthy($gvars.VERBOSE['$nil?']()) || ($truthy(strs['$empty?']())))) {
        return nil
      } else {
        return $send($gvars.stderr, 'puts', $to_a(strs))
      };
    }, -1);
    
    $def(self, '$raise', function $$raise(exception, string, backtrace) {
            if ($gvars["!"] == null) $gvars["!"] = nil;
      if ($gvars["@"] == null) $gvars["@"] = nil;

      
      ;
      
      if (string == null) string = nil;;
      
      if (backtrace == null) backtrace = nil;;
      
      if (exception == null && $gvars["!"] !== nil) {
        throw $gvars["!"];
      }
      if (exception == null) {
        exception = $$$('RuntimeError').$new("");
      }
      else if ($respond_to(exception, '$to_str')) {
        exception = $$$('RuntimeError').$new(exception.$to_str());
      }
      // using respond_to? and not an undefined check to avoid method_missing matching as true
      else if (exception.$$is_class && $respond_to(exception, '$exception')) {
        exception = exception.$exception(string);
      }
      else if (exception.$$is_exception) {
        // exception is fine
      }
      else {
        exception = $$$('TypeError').$new("exception class/object expected");
      }

      if (backtrace !== nil) {
        exception.$set_backtrace(backtrace);
      }

      if ($gvars["!"] !== nil) {
        Opal.exceptions.push($gvars["!"]);
      }

      $gvars["!"] = exception;
      $gvars["@"] = (exception).$backtrace();

      throw exception;
    ;
    }, -1);
    
    $def(self, '$rand', function $$rand(max) {
      
      
      ;
      
      if (max === undefined) {
        return $$$($$$('Random'), 'DEFAULT').$rand();
      }

      if (max.$$is_number) {
        if (max < 0) {
          max = Math.abs(max);
        }

        if (max % 1 !== 0) {
          max = max.$to_i();
        }

        if (max === 0) {
          max = undefined;
        }
      }
    ;
      return $$$($$$('Random'), 'DEFAULT').$rand(max);
    }, -1);
    
    $def(self, '$respond_to?', function $Kernel_respond_to$ques$13(name, include_all) {
      var self = this;

      
      
      if (include_all == null) include_all = false;;
      
      var body = self['$' + name];

      if (typeof(body) === "function" && !body.$$stub) {
        return true;
      }

      if (self['$respond_to_missing?'].$$pristine === true) {
        return false;
      } else {
        return self['$respond_to_missing?'](name, include_all);
      }
    ;
    }, -2);
    
    $def(self, '$respond_to_missing?', function $Kernel_respond_to_missing$ques$14(method_name, include_all) {
      
      
      
      if (include_all == null) include_all = false;;
      return false;
    }, -2);
    $Opal.$pristine(self, "respond_to?", "respond_to_missing?");
    
    $def(self, '$require', function $$require(file) {
      
      
      // As Object.require refers to Kernel.require once Kernel has been loaded the String
      // class may not be available yet, the coercion requires both  String and Array to be loaded.
      if (typeof file !== 'string' && Opal.String && Opal.Array) {
        (file = $Opal['$coerce_to!'](file, $$$('String'), "to_str"))
      }
      return Opal.require(file)
    
    }, 1);
    
    $def(self, '$require_relative', function $$require_relative(file) {
      
      
      $Opal['$try_convert!'](file, $$$('String'), "to_str");
      file = $$$('File').$expand_path($$$('File').$join(Opal.current_file, "..", file));
      return Opal.require(file);
    }, 1);
    
    $def(self, '$require_tree', function $$require_tree(path, $kwargs) {
      var autoload;

      
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      autoload = $kwargs.$$smap["autoload"];
      if (autoload == null) autoload = false;
      
      var result = [];

      path = $$$('File').$expand_path(path)
      path = Opal.normalize(path);
      if (path === '.') path = '';
      for (var name in Opal.modules) {
        if ((name)['$start_with?'](path)) {
          if(!autoload) {
            result.push([name, Opal.require(name)]);
          } else {
            result.push([name, true]); // do nothing, delegated to a autoloading
          }
        }
      }

      return result;
    ;
    }, -2);
    
    $def(self, '$singleton_class', function $$singleton_class() {
      var self = this;

      return Opal.get_singleton_class(self);
    }, 0);
    
    $def(self, '$sleep', function $$sleep(seconds) {
      
      
      
      if (seconds == null) seconds = nil;;
      
      if (seconds === nil) {
        $Kernel.$raise($$$('TypeError'), "can't convert NilClass into time interval")
      }
      if (!seconds.$$is_number) {
        $Kernel.$raise($$$('TypeError'), "can't convert " + (seconds.$class()) + " into time interval")
      }
      if (seconds < 0) {
        $Kernel.$raise($$$('ArgumentError'), "time interval must be positive")
      }
      var get_time = Opal.global.performance ?
        function() {return performance.now()} :
        function() {return new Date()}

      var t = get_time();
      while (get_time() - t <= seconds * 1000);
      return Math.round(seconds);
    ;
    }, -1);
    
    $def(self, '$srand', function $$srand(seed) {
      
      
      
      if (seed == null) seed = $$('Random').$new_seed();;
      return $$$('Random').$srand(seed);
    }, -1);
    
    $def(self, '$String', function $$String(str) {
      var $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = $Opal['$coerce_to?'](str, $$$('String'), "to_str")))) {
        return $ret_or_1
      } else {
        return $Opal['$coerce_to!'](str, $$$('String'), "to_s")
      }
    }, 1);
    
    $def(self, '$tap', function $$tap() {
      var block = $$tap.$$p || nil, self = this;

      delete $$tap.$$p;
      
      ;
      Opal.yield1(block, self);
      return self;
    }, 0);
    
    $def(self, '$to_proc', $return_self, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this;

      return "#<" + (self.$class()) + ":0x" + (self.$__id__().$to_s(16)) + ">"
    }, 0);
    
    $def(self, '$catch', function $Kernel_catch$15(tag) {
      var $yield = $Kernel_catch$15.$$p || nil, $ret_or_1 = nil, e = nil;

      delete $Kernel_catch$15.$$p;
      
      
      if (tag == null) tag = nil;;
      try {
        
        tag = ($truthy(($ret_or_1 = tag)) ? ($ret_or_1) : ($Object.$new()));
        return Opal.yield1($yield, tag);;
      } catch ($err) {
        if (Opal.rescue($err, [$$$('UncaughtThrowError')])) {(e = $err)
          try {
            
            if ($eqeq(e.$tag(), tag)) {
              return e.$value()
            };
            return $Kernel.$raise();
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      };
    }, -1);
    
    $def(self, '$throw', function $Kernel_throw$16(tag, obj) {
      
      
      
      if (obj == null) obj = nil;;
      return $Kernel.$raise($$$('UncaughtThrowError').$new(tag, obj));
    }, -2);
    
    $def(self, '$open', function $$open($a) {
      var block = $$open.$$p || nil, $post_args, args;

      delete $$open.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return $send($$$('File'), 'open', $to_a(args), block.$to_proc());
    }, -1);
    
    $def(self, '$yield_self', function $$yield_self() {
      var $yield = $$yield_self.$$p || nil, self = this;

      delete $$yield_self.$$p;
      
      if (!($yield !== nil)) {
        return $send(self, 'enum_for', ["yield_self"], $return_val(1), 0)
      };
      return Opal.yield1($yield, self);;
    }, 0);
    $alias(self, "fail", "raise");
    $alias(self, "kind_of?", "is_a?");
    $alias(self, "object_id", "__id__");
    $alias(self, "public_send", "__send__");
    $alias(self, "send", "__send__");
    $alias(self, "then", "yield_self");
    return $alias(self, "to_enum", "enum_for");
  })('::', $nesting);
  return (function($base, $super) {
    var self = $klass($base, $super, 'Object');

    
    
    delete $Object.$$prototype.$require;
    return self.$include($Kernel);
  })('::', null);
};

Opal.modules["corelib/main"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $return_val = Opal.return_val, $def = Opal.def, $Object = Opal.Object, $Kernel = Opal.Kernel;

  Opal.add_stubs('include,raise');
  return (function(self, $parent_nesting) {
    
    
    
    $def(self, '$to_s', $return_val("main"), 0);
    
    $def(self, '$include', function $$include(mod) {
      
      return $Object.$include(mod)
    }, 1);
    
    $def(self, '$autoload', function $$autoload($a) {
      var $post_args, args;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return Opal.Object.$autoload.apply(Opal.Object, args);;
    }, -1);
    return $def(self, '$using', function $$using(mod) {
      
      return $Kernel.$raise("main.using is permitted only at toplevel")
    }, 1);
  })(Opal.get_singleton_class(self), $nesting)
};

Opal.modules["corelib/error/errno"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $truthy = Opal.truthy, $rb_plus = Opal.rb_plus, $send2 = Opal.send2, $find_super = Opal.find_super, $def = Opal.def, $klass = Opal.klass;

  Opal.add_stubs('+,errno,class,attr_reader');
  
  (function($base, $parent_nesting) {
    var self = $module($base, 'Errno');

    var $nesting = [self].concat($parent_nesting), errors = nil, klass = nil;

    
    errors = [["EINVAL", "Invalid argument", 22], ["EEXIST", "File exists", 17], ["EISDIR", "Is a directory", 21], ["EMFILE", "Too many open files", 24], ["EACCES", "Permission denied", 13], ["EPERM", "Operation not permitted", 1], ["ENOENT", "No such file or directory", 2]];
    klass = nil;
    
    var i;
    for (i = 0; i < errors.length; i++) {
      (function() { // Create a closure
        var class_name = errors[i][0];
        var default_message = errors[i][1];
        var errno = errors[i][2];

        klass = Opal.klass(self, Opal.SystemCallError, class_name);
        klass.errno = errno;

        (function(self, $parent_nesting) {
      
      return $def(self, '$new', function $new$1(name) {
        var $yield = $new$1.$$p || nil, self = this, message = nil;

        delete $new$1.$$p;
        
        
        if (name == null) name = nil;;
        message = default_message;
        if ($truthy(name)) {
          message = $rb_plus(message, " - " + (name))
        };
        return $send2(self, $find_super(self, 'new', $new$1, false, true), 'new', [message], null);
      }, -1)
    })(Opal.get_singleton_class(klass), $nesting)
      })();
    }
  ;
  })('::', $nesting);
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'SystemCallError');

    var $nesting = [self].concat($parent_nesting);

    
    
    $def(self, '$errno', function $$errno() {
      var self = this;

      return self.$class().$errno()
    }, 0);
    return (function(self, $parent_nesting) {
      
      return self.$attr_reader("errno")
    })(Opal.get_singleton_class(self), $nesting);
  })('::', $$$('StandardError'), $nesting);
};

Opal.modules["corelib/error"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $gvars = Opal.gvars, $defs = Opal.defs, $send = Opal.send, $to_a = Opal.to_a, $def = Opal.def, $truthy = Opal.truthy, $hash2 = Opal.hash2, $Kernel = Opal.Kernel, $not = Opal.not, $rb_plus = Opal.rb_plus, $eqeq = Opal.eqeq, $Object = Opal.Object, $send2 = Opal.send2, $find_super = Opal.find_super, $module = Opal.module;

  Opal.add_stubs('new,map,backtrace,clone,to_s,merge,tty?,[],include?,raise,dup,empty?,!,caller,shift,+,class,join,cause,full_message,==,reverse,split,autoload,attr_reader,inspect');
  
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Exception');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.message = nil;
    
    Opal.prop(self.$$prototype, '$$is_exception', true);
    var stack_trace_limit;
    $defs(self, '$new', function $Exception_new$1($a) {
      var $post_args, args, self = this;
      if ($gvars["!"] == null) $gvars["!"] = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var message   = (args.length > 0) ? args[0] : nil;
      var error     = new self.$$constructor(message);
      error.name    = self.$$name;
      error.message = message;
      error.cause   = $gvars["!"];
      Opal.send(error, error.$initialize, args);

      // Error.captureStackTrace() will use .name and .toString to build the
      // first line of the stack trace so it must be called after the error
      // has been initialized.
      // https://nodejs.org/dist/latest-v6.x/docs/api/errors.html
      if (Opal.config.enable_stack_trace && Error.captureStackTrace) {
        // Passing Kernel.raise will cut the stack trace from that point above
        Error.captureStackTrace(error, stack_trace_limit);
      }

      return error;
    ;
    }, -1);
    stack_trace_limit = self.$new;
    $defs(self, '$exception', function $$exception($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return $send(self, 'new', $to_a(args));
    }, -1);
    
    $def(self, '$initialize', function $$initialize($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return self.message = (args.length > 0) ? args[0] : nil;;
    }, -1);
    
    // Convert backtrace from any format to Ruby format
    function correct_backtrace(backtrace) {
      var new_bt = [], m;

      for (var i = 0; i < backtrace.length; i++) {
        var loc = backtrace[i];
        if (!loc || !loc.$$is_string) {
          /* Do nothing */
        }
        /* Chromium format */
        else if ((m = loc.match(/^    at (.*?) \((.*?)\)$/))) {
          new_bt.push(m[2] + ":in `" + m[1] + "'");
        }
        else if ((m = loc.match(/^    at (.*?)$/))) {
          new_bt.push(m[1] + ":in `undefined'");
        }
        /* Node format */
        else if ((m = loc.match(/^  from (.*?)$/))) {
          new_bt.push(m[1]);
        }
        /* Mozilla/Apple format */
        else if ((m = loc.match(/^(.*?)@(.*?)$/))) {
          new_bt.push(m[2] + ':in `' + m[1] + "'");
        }
      }

      return new_bt;
    }
  ;
    
    $def(self, '$backtrace', function $$backtrace() {
      var self = this;

      
      if (self.backtrace) {
        // nil is a valid backtrace
        return self.backtrace;
      }

      var backtrace = self.stack;

      if (typeof(backtrace) !== 'undefined' && backtrace.$$is_string) {
        return self.backtrace = correct_backtrace(backtrace.split("\n").slice(0, 15));
      }
      else if (backtrace) {
        return self.backtrace = correct_backtrace(backtrace.slice(0, 15));
      }

      return [];
    
    }, 0);
    
    $def(self, '$backtrace_locations', function $$backtrace_locations() {
      var $a, self = this;

      
      if (self.backtrace_locations) return self.backtrace_locations;
      self.backtrace_locations = ($a = self.$backtrace(), ($a === nil || $a == null) ? nil : $send($a, 'map', [], function $$2(loc){
        
        
        if (loc == null) loc = nil;;
        return $$$($$$($$$('Thread'), 'Backtrace'), 'Location').$new(loc);}, 1))
      return self.backtrace_locations;
    
    }, 0);
    
    $def(self, '$cause', function $$cause() {
      var self = this;

      return self.cause || nil;
    }, 0);
    
    $def(self, '$exception', function $$exception(str) {
      var self = this;

      
      
      if (str == null) str = nil;;
      
      if (str === nil || self === str) {
        return self;
      }

      var cloned = self.$clone();
      cloned.message = str;
      if (self.backtrace) cloned.backtrace = self.backtrace.$dup();
      cloned.stack = self.stack;
      cloned.cause = self.cause;
      return cloned;
    ;
    }, -1);
    
    $def(self, '$message', function $$message() {
      var self = this;

      return self.$to_s()
    }, 0);
    
    $def(self, '$full_message', function $$full_message(kwargs) {
      var $a, $b, self = this, $ret_or_1 = nil, highlight = nil, order = nil, bold_underline = nil, bold = nil, reset = nil, bt = nil, first = nil, msg = nil;
      if ($gvars.stderr == null) $gvars.stderr = nil;

      
      
      if (kwargs == null) kwargs = nil;;
      if (!$truthy((($a = $$('Hash', 'skip_raise')) ? 'constant' : nil))) {
        return "" + (self.message) + "\n" + (self.stack)
      };
      kwargs = $hash2(["highlight", "order"], {"highlight": $gvars.stderr['$tty?'](), "order": "top"}).$merge(($truthy(($ret_or_1 = kwargs)) ? ($ret_or_1) : ($hash2([], {}))));
      $b = [kwargs['$[]']("highlight"), kwargs['$[]']("order")], (highlight = $b[0]), (order = $b[1]), $b;
      if (!$truthy([true, false]['$include?'](highlight))) {
        $Kernel.$raise($$$('ArgumentError'), "expected true or false as highlight: " + (highlight))
      };
      if (!$truthy(["top", "bottom"]['$include?'](order))) {
        $Kernel.$raise($$$('ArgumentError'), "expected :top or :bottom as order: " + (order))
      };
      if ($truthy(highlight)) {
        
        bold_underline = "\u001b[1;4m";
        bold = "\u001b[1m";
        reset = "\u001b[m";
      } else {
        bold_underline = (bold = (reset = ""))
      };
      bt = self.$backtrace().$dup();
      if (($not(bt) || ($truthy(bt['$empty?']())))) {
        bt = self.$caller()
      };
      first = bt.$shift();
      msg = "" + (first) + ": ";
      msg = $rb_plus(msg, "" + (bold) + (self.$to_s()) + " (" + (bold_underline) + (self.$class()) + (reset) + (bold) + ")" + (reset) + "\n");
      msg = $rb_plus(msg, $send(bt, 'map', [], function $$3(loc){
        
        
        if (loc == null) loc = nil;;
        return "\tfrom " + (loc) + "\n";}, 1).$join());
      if ($truthy(self.$cause())) {
        msg = $rb_plus(msg, self.$cause().$full_message($hash2(["highlight"], {"highlight": highlight})))
      };
      if ($eqeq(order, "bottom")) {
        
        msg = msg.$split("\n").$reverse().$join("\n");
        msg = $rb_plus("" + (bold) + "Traceback" + (reset) + " (most recent call last):\n", msg);
      };
      return msg;
    }, -1);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this, as_str = nil;

      
      as_str = self.$to_s();
      if ($truthy(as_str['$empty?']())) {
        return self.$class().$to_s()
      } else {
        return "#<" + (self.$class().$to_s()) + ": " + (self.$to_s()) + ">"
      };
    }, 0);
    
    $def(self, '$set_backtrace', function $$set_backtrace(backtrace) {
      var self = this;

      
      var valid = true, i, ii;

      if (backtrace === nil) {
        self.backtrace = nil;
        self.stack = '';
      } else if (backtrace.$$is_string) {
        self.backtrace = [backtrace];
        self.stack = '  from ' + backtrace;
      } else {
        if (backtrace.$$is_array) {
          for (i = 0, ii = backtrace.length; i < ii; i++) {
            if (!backtrace[i].$$is_string) {
              valid = false;
              break;
            }
          }
        } else {
          valid = false;
        }

        if (valid === false) {
          $Kernel.$raise($$$('TypeError'), "backtrace must be Array of String")
        }

        self.backtrace = backtrace;
        self.stack = $send((backtrace), 'map', [], function $$4(i){
        
        
        if (i == null) i = nil;;
        return $rb_plus("  from ", i);}, 1).join("\n");
      }

      return backtrace;
    
    }, 1);
    return $def(self, '$to_s', function $$to_s() {
      var self = this, $ret_or_1 = nil, $ret_or_2 = nil;

      if ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = self.message)) ? (self.message.$to_s()) : ($ret_or_2))))) {
        return $ret_or_1
      } else {
        return self.$class().$to_s()
      }
    }, 0);
  })('::', Error, $nesting);
  $klass('::', $$$('Exception'), 'ScriptError');
  $klass('::', $$$('ScriptError'), 'SyntaxError');
  $klass('::', $$$('ScriptError'), 'LoadError');
  $klass('::', $$$('ScriptError'), 'NotImplementedError');
  $klass('::', $$$('Exception'), 'SystemExit');
  $klass('::', $$$('Exception'), 'NoMemoryError');
  $klass('::', $$$('Exception'), 'SignalException');
  $klass('::', $$$('SignalException'), 'Interrupt');
  $klass('::', $$$('Exception'), 'SecurityError');
  $klass('::', $$$('Exception'), 'SystemStackError');
  $klass('::', $$$('Exception'), 'StandardError');
  $klass('::', $$$('StandardError'), 'EncodingError');
  $klass('::', $$$('StandardError'), 'ZeroDivisionError');
  $klass('::', $$$('StandardError'), 'NameError');
  $klass('::', $$$('NameError'), 'NoMethodError');
  $klass('::', $$$('StandardError'), 'RuntimeError');
  $klass('::', $$$('RuntimeError'), 'FrozenError');
  $klass('::', $$$('StandardError'), 'LocalJumpError');
  $klass('::', $$$('StandardError'), 'TypeError');
  $klass('::', $$$('StandardError'), 'ArgumentError');
  $klass('::', $$$('ArgumentError'), 'UncaughtThrowError');
  $klass('::', $$$('StandardError'), 'IndexError');
  $klass('::', $$$('IndexError'), 'StopIteration');
  $klass('::', $$$('StopIteration'), 'ClosedQueueError');
  $klass('::', $$$('IndexError'), 'KeyError');
  $klass('::', $$$('StandardError'), 'RangeError');
  $klass('::', $$$('RangeError'), 'FloatDomainError');
  $klass('::', $$$('StandardError'), 'IOError');
  $klass('::', $$$('IOError'), 'EOFError');
  $klass('::', $$$('StandardError'), 'SystemCallError');
  $klass('::', $$$('StandardError'), 'RegexpError');
  $klass('::', $$$('StandardError'), 'ThreadError');
  $klass('::', $$$('StandardError'), 'FiberError');
  $Object.$autoload("Errno", "corelib/error/errno");
  (function($base, $super) {
    var self = $klass($base, $super, 'UncaughtThrowError');

    var $proto = self.$$prototype;

    $proto.tag = nil;
    
    self.$attr_reader("tag", "value");
    return $def(self, '$initialize', function $$initialize(tag, value) {
      var $yield = $$initialize.$$p || nil, self = this;

      delete $$initialize.$$p;
      
      
      if (value == null) value = nil;;
      self.tag = tag;
      self.value = value;
      return $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', ["uncaught throw " + (self.tag.$inspect())], null);
    }, -2);
  })('::', $$$('ArgumentError'));
  (function($base, $super) {
    var self = $klass($base, $super, 'NameError');

    
    
    self.$attr_reader("name");
    return $def(self, '$initialize', function $$initialize(message, name) {
      var $yield = $$initialize.$$p || nil, self = this;

      delete $$initialize.$$p;
      
      
      if (name == null) name = nil;;
      $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', [message], null);
      return (self.name = name);
    }, -2);
  })('::', null);
  (function($base, $super) {
    var self = $klass($base, $super, 'NoMethodError');

    
    
    self.$attr_reader("args");
    return $def(self, '$initialize', function $$initialize(message, name, args) {
      var $yield = $$initialize.$$p || nil, self = this;

      delete $$initialize.$$p;
      
      
      if (name == null) name = nil;;
      
      if (args == null) args = [];;
      $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', [message, name], null);
      return (self.args = args);
    }, -2);
  })('::', null);
  (function($base, $super) {
    var self = $klass($base, $super, 'StopIteration');

    
    return self.$attr_reader("result")
  })('::', null);
  (function($base, $super) {
    var self = $klass($base, $super, 'KeyError');

    var $proto = self.$$prototype;

    $proto.receiver = $proto.key = nil;
    
    
    $def(self, '$initialize', function $$initialize(message, $kwargs) {
      var receiver, key, $yield = $$initialize.$$p || nil, self = this;

      delete $$initialize.$$p;
      
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      receiver = $kwargs.$$smap["receiver"];
      if (receiver == null) receiver = nil;
      
      key = $kwargs.$$smap["key"];
      if (key == null) key = nil;
      $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', [message], null);
      self.receiver = receiver;
      return (self.key = key);
    }, -2);
    
    $def(self, '$receiver', function $$receiver() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.receiver))) {
        return $ret_or_1
      } else {
        return $Kernel.$raise($$$('ArgumentError'), "no receiver is available")
      }
    }, 0);
    return $def(self, '$key', function $$key() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.key))) {
        return $ret_or_1
      } else {
        return $Kernel.$raise($$$('ArgumentError'), "no key is available")
      }
    }, 0);
  })('::', null);
  return (function($base, $parent_nesting) {
    var self = $module($base, 'JS');

    var $nesting = [self].concat($parent_nesting);

    return ($klass($nesting[0], null, 'Error'), nil)
  })('::', $nesting);
};

Opal.modules["corelib/constants"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $const_set = Opal.const_set;

  
  $const_set('::', 'RUBY_PLATFORM', "opal");
  $const_set('::', 'RUBY_ENGINE', "opal");
  $const_set('::', 'RUBY_VERSION', "3.1.0");
  $const_set('::', 'RUBY_ENGINE_VERSION', "1.5.1");
  $const_set('::', 'RUBY_RELEASE_DATE', "2022-07-20");
  $const_set('::', 'RUBY_PATCHLEVEL', 0);
  $const_set('::', 'RUBY_REVISION', "0");
  $const_set('::', 'RUBY_COPYRIGHT', "opal - Copyright (C) 2013-2022 Adam Beynon and the Opal contributors");
  return $const_set('::', 'RUBY_DESCRIPTION', "opal " + ($$$('RUBY_ENGINE_VERSION')) + " (" + ($$$('RUBY_RELEASE_DATE')) + " revision " + ($$$('RUBY_REVISION')) + ")");
};

Opal.modules["opal/base"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $Object = Opal.Object;

  Opal.add_stubs('require');
  
  $Object.$require("corelib/runtime");
  $Object.$require("corelib/helpers");
  $Object.$require("corelib/module");
  $Object.$require("corelib/class");
  $Object.$require("corelib/basic_object");
  $Object.$require("corelib/kernel");
  $Object.$require("corelib/main");
  $Object.$require("corelib/error");
  return $Object.$require("corelib/constants");
};

Opal.modules["corelib/nil"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $Kernel = Opal.Kernel, $def = Opal.def, $return_val = Opal.return_val, $hash2 = Opal.hash2, $NilClass = Opal.NilClass, $truthy = Opal.truthy, $rb_gt = Opal.rb_gt, $alias = Opal.alias;

  Opal.add_stubs('raise,name,new,>,length,Rational,to_i');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'NilClass');

    var $nesting = [self].concat($parent_nesting);

    
    self.$$prototype.$$meta = self;
    (function(self, $parent_nesting) {
      
      
      
      $def(self, '$allocate', function $$allocate() {
        var self = this;

        return $Kernel.$raise($$$('TypeError'), "allocator undefined for " + (self.$name()))
      }, 0);
      
      
      Opal.udef(self, '$' + "new");;
      return nil;;
    })(Opal.get_singleton_class(self), $nesting);
    
    $def(self, '$!', $return_val(true), 0);
    
    $def(self, '$&', $return_val(false), 0);
    
    $def(self, '$|', function $NilClass_$$1(other) {
      
      return other !== false && other !== nil;
    }, 1);
    
    $def(self, '$^', function $NilClass_$$2(other) {
      
      return other !== false && other !== nil;
    }, 1);
    
    $def(self, '$==', function $NilClass_$eq_eq$3(other) {
      
      return other === nil;
    }, 1);
    
    $def(self, '$dup', $return_val(nil), 0);
    
    $def(self, '$clone', function $$clone($kwargs) {
      var freeze;

      
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      freeze = $kwargs.$$smap["freeze"];
      if (freeze == null) freeze = true;
      return nil;
    }, -1);
    
    $def(self, '$inspect', $return_val("nil"), 0);
    
    $def(self, '$nil?', $return_val(true), 0);
    
    $def(self, '$singleton_class', function $$singleton_class() {
      
      return $NilClass
    }, 0);
    
    $def(self, '$to_a', function $$to_a() {
      
      return []
    }, 0);
    
    $def(self, '$to_h', function $$to_h() {
      
      return Opal.hash();
    }, 0);
    
    $def(self, '$to_i', $return_val(0), 0);
    
    $def(self, '$to_s', $return_val(""), 0);
    
    $def(self, '$to_c', function $$to_c() {
      
      return $$$('Complex').$new(0, 0)
    }, 0);
    
    $def(self, '$rationalize', function $$rationalize($a) {
      var $post_args, args;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if ($truthy($rb_gt(args.$length(), 1))) {
        $Kernel.$raise($$$('ArgumentError'))
      };
      return $Kernel.$Rational(0, 1);
    }, -1);
    
    $def(self, '$to_r', function $$to_r() {
      
      return $Kernel.$Rational(0, 1)
    }, 0);
    
    $def(self, '$instance_variables', function $$instance_variables() {
      
      return []
    }, 0);
    return $alias(self, "to_f", "to_i");
  })('::', null, $nesting)
};

Opal.modules["corelib/boolean"] = function(Opal) {/* Generated by Opal 1.5.1 */
  "use strict";
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $Kernel = Opal.Kernel, $def = Opal.def, $return_self = Opal.return_self, $hash2 = Opal.hash2, $truthy = Opal.truthy, $send2 = Opal.send2, $find_super = Opal.find_super, $to_a = Opal.to_a, $alias = Opal.alias;

  Opal.add_stubs('raise,name,==,to_s,__id__');
  
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Boolean');

    var $nesting = [self].concat($parent_nesting);

    
    Opal.prop(self.$$prototype, '$$is_boolean', true);
    
    var properties = ['$$class', '$$meta'];

    for (var i = 0; i < properties.length; i++) {
      Object.defineProperty(self.$$prototype, properties[i], {
        configurable: true,
        enumerable: false,
        get: function() {
          return this == true  ? Opal.TrueClass :
                 this == false ? Opal.FalseClass :
                                 Opal.Boolean;
        }
      });
    }

    Object.defineProperty(self.$$prototype, "$$id", {
      configurable: true,
      enumerable: false,
      get: function() {
        return this == true  ? 2 :
               this == false ? 0 :
                               nil;
      }
    });
  ;
    (function(self, $parent_nesting) {
      
      
      
      $def(self, '$allocate', function $$allocate() {
        var self = this;

        return $Kernel.$raise($$$('TypeError'), "allocator undefined for " + (self.$name()))
      }, 0);
      
      
      Opal.udef(self, '$' + "new");;
      return nil;;
    })(Opal.get_singleton_class(self), $nesting);
    
    $def(self, '$__id__', function $$__id__() {
      var self = this;

      return self.valueOf() ? 2 : 0;
    }, 0);
    
    $def(self, '$!', function $Boolean_$excl$1() {
      var self = this;

      return self != true;
    }, 0);
    
    $def(self, '$&', function $Boolean_$$2(other) {
      var self = this;

      return (self == true) ? (other !== false && other !== nil) : false;
    }, 1);
    
    $def(self, '$|', function $Boolean_$$3(other) {
      var self = this;

      return (self == true) ? true : (other !== false && other !== nil);
    }, 1);
    
    $def(self, '$^', function $Boolean_$$4(other) {
      var self = this;

      return (self == true) ? (other === false || other === nil) : (other !== false && other !== nil);
    }, 1);
    
    $def(self, '$==', function $Boolean_$eq_eq$5(other) {
      var self = this;

      return (self == true) === other.valueOf();
    }, 1);
    
    $def(self, '$singleton_class', function $$singleton_class() {
      var self = this;

      return self.$$meta;
    }, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, 0);
    
    $def(self, '$dup', $return_self, 0);
    
    $def(self, '$clone', function $$clone($kwargs) {
      var freeze, self = this;

      
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      freeze = $kwargs.$$smap["freeze"];
      if (freeze == null) freeze = true;
      return self;
    }, -1);
    
    $def(self, '$method_missing', function $$method_missing(method, $a) {
      var block = $$method_missing.$$p || nil, $post_args, args, self = this;

      delete $$method_missing.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      var body = self.$$class.$$prototype['$' + method];
      if (!$truthy(typeof body !== 'undefined' && !body.$$stub)) {
        $send2(self, $find_super(self, 'method_missing', $$method_missing, false, true), 'method_missing', [method].concat($to_a(args)), block)
      };
      return Opal.send(self, body, args, block);
    }, -2);
    
    $def(self, '$respond_to_missing?', function $Boolean_respond_to_missing$ques$6(method, _include_all) {
      var self = this;

      
      
      if (_include_all == null) _include_all = false;;
      var body = self.$$class.$$prototype['$' + method];
      return typeof body !== 'undefined' && !body.$$stub;;
    }, -2);
    $alias(self, "eql?", "==");
    $alias(self, "equal?", "==");
    $alias(self, "inspect", "to_s");
    return $alias(self, "object_id", "__id__");
  })('::', Boolean, $nesting);
  $klass('::', $$$('Boolean'), 'TrueClass');
  return ($klass('::', $$$('Boolean'), 'FalseClass'), nil);
};

Opal.modules["corelib/comparable"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $module = Opal.module, $rb_gt = Opal.rb_gt, $rb_lt = Opal.rb_lt, $eqeqeq = Opal.eqeqeq, $Kernel = Opal.Kernel, $def = Opal.def;

  Opal.add_stubs('>,<,===,raise,class,<=>,equal?');
  return (function($base) {
    var self = $module($base, 'Comparable');

    var $ret_or_1 = nil;

    
    
    function normalize(what) {
      if (Opal.is_a(what, Opal.Integer)) { return what; }

      if ($rb_gt(what, 0)) { return 1; }
      if ($rb_lt(what, 0)) { return -1; }
      return 0;
    }

    function fail_comparison(lhs, rhs) {
      var class_name;
      (($eqeqeq(nil, ($ret_or_1 = rhs)) || (($eqeqeq(true, $ret_or_1) || (($eqeqeq(false, $ret_or_1) || (($eqeqeq($$$('Integer'), $ret_or_1) || ($eqeqeq($$$('Float'), $ret_or_1))))))))) ? (class_name = rhs.$inspect()) : (class_name = rhs.$$class))
      $Kernel.$raise($$$('ArgumentError'), "comparison of " + ((lhs).$class()) + " with " + (class_name) + " failed")
    }

    function cmp_or_fail(lhs, rhs) {
      var cmp = (lhs)['$<=>'](rhs);
      if (!$truthy(cmp)) fail_comparison(lhs, rhs);
      return normalize(cmp);
    }
  ;
    
    $def(self, '$==', function $Comparable_$eq_eq$1(other) {
      var self = this, cmp = nil;

      
      if ($truthy(self['$equal?'](other))) {
        return true
      };
      
      if (self["$<=>"] == Opal.Kernel["$<=>"]) {
        return false;
      }

      // check for infinite recursion
      if (self.$$comparable) {
        delete self.$$comparable;
        return false;
      }
    ;
      if (!$truthy((cmp = self['$<=>'](other)))) {
        return false
      };
      return normalize(cmp) == 0;;
    }, 1);
    
    $def(self, '$>', function $Comparable_$gt$2(other) {
      var self = this;

      return cmp_or_fail(self, other) > 0;
    }, 1);
    
    $def(self, '$>=', function $Comparable_$gt_eq$3(other) {
      var self = this;

      return cmp_or_fail(self, other) >= 0;
    }, 1);
    
    $def(self, '$<', function $Comparable_$lt$4(other) {
      var self = this;

      return cmp_or_fail(self, other) < 0;
    }, 1);
    
    $def(self, '$<=', function $Comparable_$lt_eq$5(other) {
      var self = this;

      return cmp_or_fail(self, other) <= 0;
    }, 1);
    
    $def(self, '$between?', function $Comparable_between$ques$6(min, max) {
      var self = this;

      
      if ($rb_lt(self, min)) {
        return false
      };
      if ($rb_gt(self, max)) {
        return false
      };
      return true;
    }, 2);
    return $def(self, '$clamp', function $$clamp(min, max) {
      var self = this;

      
      
      if (max == null) max = nil;;
      
      var c, excl;

      if (max === nil) {
        // We are dealing with a new Ruby 2.7 behaviour that we are able to
        // provide a single Range argument instead of 2 Comparables.

        if (!Opal.is_a(min, Opal.Range)) {
          $Kernel.$raise($$$('TypeError'), "wrong argument type " + (min.$class()) + " (expected Range)")
        }

        excl = min.excl;
        max = min.end;
        min = min.begin;

        if (max !== nil && excl) {
          $Kernel.$raise($$$('ArgumentError'), "cannot clamp with an exclusive range")
        }
      }

      if (min !== nil && max !== nil && cmp_or_fail(min, max) > 0) {
        $Kernel.$raise($$$('ArgumentError'), "min argument must be smaller than max argument")
      }

      if (min !== nil) {
        c = cmp_or_fail(self, min);

        if (c == 0) return self;
        if (c < 0) return min;
      }

      if (max !== nil) {
        c = cmp_or_fail(self, max);

        if (c > 0) return max;
      }

      return self;
    ;
    }, -2);
  })('::')
};

Opal.modules["corelib/regexp"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $coerce_to = Opal.coerce_to, $klass = Opal.klass, $const_set = Opal.const_set, $send2 = Opal.send2, $find_super = Opal.find_super, $def = Opal.def, $truthy = Opal.truthy, $gvars = Opal.gvars, $Kernel = Opal.Kernel, $Opal = Opal.Opal, $alias = Opal.alias, $send = Opal.send, $hash2 = Opal.hash2, $rb_plus = Opal.rb_plus, $rb_ge = Opal.rb_ge, $to_a = Opal.to_a, $eqeqeq = Opal.eqeqeq, $rb_minus = Opal.rb_minus, $return_ivar = Opal.return_ivar;

  Opal.add_stubs('nil?,[],raise,escape,options,to_str,new,join,coerce_to!,!,match,coerce_to?,begin,uniq,map,scan,source,to_proc,transform_values,group_by,each_with_index,+,last,=~,==,attr_reader,>=,length,is_a?,include?,names,regexp,named_captures,===,captures,-,inspect,empty?,each,to_a');
  
  $klass('::', $$$('StandardError'), 'RegexpError');
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Regexp');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    $const_set(self, 'IGNORECASE', 1);
    $const_set(self, 'EXTENDED', 2);
    $const_set(self, 'MULTILINE', 4);
    Opal.prop(self.$$prototype, '$$is_regexp', true);
    (function(self, $parent_nesting) {
      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      
      $def(self, '$allocate', function $$allocate() {
        var $yield = $$allocate.$$p || nil, self = this, allocated = nil;

        delete $$allocate.$$p;
        
        allocated = $send2(self, $find_super(self, 'allocate', $$allocate, false, true), 'allocate', [], $yield);
        allocated.uninitialized = true;
        return allocated;
      }, 0);
      
      $def(self, '$escape', function $$escape(string) {
        
        return Opal.escape_regexp(string);
      }, 1);
      
      $def(self, '$last_match', function $$last_match(n) {
                if ($gvars["~"] == null) $gvars["~"] = nil;

        
        
        if (n == null) n = nil;;
        if ($truthy(n['$nil?']())) {
          return $gvars["~"]
        } else if ($truthy($gvars["~"])) {
          return $gvars["~"]['$[]'](n)
        } else {
          return nil
        };
      }, -1);
      
      $def(self, '$union', function $$union($a) {
        var $post_args, parts, self = this;

        
        
        $post_args = Opal.slice.call(arguments);
        
        parts = $post_args;;
        
        var is_first_part_array, quoted_validated, part, options, each_part_options;
        if (parts.length == 0) {
          return /(?!)/;
        }
        // return fast if there's only one element
        if (parts.length == 1 && parts[0].$$is_regexp) {
          return parts[0];
        }
        // cover the 2 arrays passed as arguments case
        is_first_part_array = parts[0].$$is_array;
        if (parts.length > 1 && is_first_part_array) {
          $Kernel.$raise($$$('TypeError'), "no implicit conversion of Array into String")
        }
        // deal with splat issues (related to https://github.com/opal/opal/issues/858)
        if (is_first_part_array) {
          parts = parts[0];
        }
        options = undefined;
        quoted_validated = [];
        for (var i=0; i < parts.length; i++) {
          part = parts[i];
          if (part.$$is_string) {
            quoted_validated.push(self.$escape(part));
          }
          else if (part.$$is_regexp) {
            each_part_options = (part).$options();
            if (options != undefined && options != each_part_options) {
              $Kernel.$raise($$$('TypeError'), "All expressions must use the same options")
            }
            options = each_part_options;
            quoted_validated.push('('+part.source+')');
          }
          else {
            quoted_validated.push(self.$escape((part).$to_str()));
          }
        }
      ;
        return self.$new((quoted_validated).$join("|"), options);
      }, -1);
      
      $def(self, '$new', function $new$1(regexp, options) {
        
        
        ;
        
        if (regexp.$$is_regexp) {
          return new RegExp(regexp);
        }

        regexp = $Opal['$coerce_to!'](regexp, $$$('String'), "to_str");

        if (regexp.charAt(regexp.length - 1) === '\\' && regexp.charAt(regexp.length - 2) !== '\\') {
          $Kernel.$raise($$$('RegexpError'), "too short escape sequence: /" + (regexp) + "/")
        }

        regexp = regexp.replace('\\A', '^').replace('\\z', '$')

        if (options === undefined || options['$!']()) {
          return new RegExp(regexp);
        }

        if (options.$$is_number) {
          var temp = '';
          if ($$('IGNORECASE') & options) { temp += 'i'; }
          if ($$('MULTILINE')  & options) { temp += 'm'; }
          options = temp;
        }
        else {
          options = 'i';
        }

        return new RegExp(regexp, options);
      ;
      }, -2);
      $alias(self, "compile", "new");
      return $alias(self, "quote", "escape");
    })(Opal.get_singleton_class(self), $nesting);
    
    $def(self, '$==', function $Regexp_$eq_eq$2(other) {
      var self = this;

      return other instanceof RegExp && self.toString() === other.toString();
    }, 1);
    
    $def(self, '$===', function $Regexp_$eq_eq_eq$3(string) {
      var self = this;

      return self.$match($Opal['$coerce_to?'](string, $$$('String'), "to_str")) !== nil
    }, 1);
    
    $def(self, '$=~', function $Regexp_$eq_tilde$4(string) {
      var self = this, $ret_or_1 = nil;
      if ($gvars["~"] == null) $gvars["~"] = nil;

      if ($truthy(($ret_or_1 = self.$match(string)))) {
        return $gvars["~"].$begin(0)
      } else {
        return $ret_or_1
      }
    }, 1);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      
      var regexp_format = /^\/(.*)\/([^\/]*)$/;
      var value = self.toString();
      var matches = regexp_format.exec(value);
      if (matches) {
        var regexp_pattern = matches[1];
        var regexp_flags = matches[2];
        var chars = regexp_pattern.split('');
        var chars_length = chars.length;
        var char_escaped = false;
        var regexp_pattern_escaped = '';
        for (var i = 0; i < chars_length; i++) {
          var current_char = chars[i];
          if (!char_escaped && current_char == '/') {
            regexp_pattern_escaped = regexp_pattern_escaped.concat('\\');
          }
          regexp_pattern_escaped = regexp_pattern_escaped.concat(current_char);
          if (current_char == '\\') {
            if (char_escaped) {
              // does not over escape
              char_escaped = false;
            } else {
              char_escaped = true;
            }
          } else {
            char_escaped = false;
          }
        }
        return '/' + regexp_pattern_escaped + '/' + regexp_flags;
      } else {
        return value;
      }
    
    }, 0);
    
    $def(self, '$match', function $$match(string, pos) {
      var block = $$match.$$p || nil, self = this;
      if ($gvars["~"] == null) $gvars["~"] = nil;

      delete $$match.$$p;
      
      ;
      ;
      
      if (self.uninitialized) {
        $Kernel.$raise($$$('TypeError'), "uninitialized Regexp")
      }

      if (pos === undefined) {
        if (string === nil) return ($gvars["~"] = nil);
        var m = self.exec($coerce_to(string, $$$('String'), 'to_str'));
        if (m) {
          ($gvars["~"] = $$$('MatchData').$new(self, m));
          return block === nil ? $gvars["~"] : Opal.yield1(block, $gvars["~"]);
        } else {
          return ($gvars["~"] = nil);
        }
      }

      pos = $coerce_to(pos, $$$('Integer'), 'to_int');

      if (string === nil) {
        return ($gvars["~"] = nil);
      }

      string = $coerce_to(string, $$$('String'), 'to_str');

      if (pos < 0) {
        pos += string.length;
        if (pos < 0) {
          return ($gvars["~"] = nil);
        }
      }

      // global RegExp maintains state, so not using self/this
      var md, re = Opal.global_regexp(self);

      while (true) {
        md = re.exec(string);
        if (md === null) {
          return ($gvars["~"] = nil);
        }
        if (md.index >= pos) {
          ($gvars["~"] = $$$('MatchData').$new(re, md));
          return block === nil ? $gvars["~"] : Opal.yield1(block, $gvars["~"]);
        }
        re.lastIndex = md.index + 1;
      }
    ;
    }, -2);
    
    $def(self, '$match?', function $Regexp_match$ques$5(string, pos) {
      var self = this;

      
      ;
      
      if (self.uninitialized) {
        $Kernel.$raise($$$('TypeError'), "uninitialized Regexp")
      }

      if (pos === undefined) {
        return string === nil ? false : self.test($coerce_to(string, $$$('String'), 'to_str'));
      }

      pos = $coerce_to(pos, $$$('Integer'), 'to_int');

      if (string === nil) {
        return false;
      }

      string = $coerce_to(string, $$$('String'), 'to_str');

      if (pos < 0) {
        pos += string.length;
        if (pos < 0) {
          return false;
        }
      }

      // global RegExp maintains state, so not using self/this
      var md, re = Opal.global_regexp(self);

      md = re.exec(string);
      if (md === null || md.index < pos) {
        return false;
      } else {
        return true;
      }
    ;
    }, -2);
    
    $def(self, '$names', function $$names() {
      var self = this;

      return $send(self.$source().$scan(/\(?<(\w+)>/, $hash2(["no_matchdata"], {"no_matchdata": true})), 'map', [], "first".$to_proc()).$uniq()
    }, 0);
    
    $def(self, '$named_captures', function $$named_captures() {
      var self = this;

      return $send($send($send(self.$source().$scan(/\(?<(\w+)>/, $hash2(["no_matchdata"], {"no_matchdata": true})), 'map', [], "first".$to_proc()).$each_with_index(), 'group_by', [], "first".$to_proc()), 'transform_values', [], function $$6(i){
        
        
        if (i == null) i = nil;;
        return $send(i, 'map', [], function $$7(j){
          
          
          if (j == null) j = nil;;
          return $rb_plus(j.$last(), 1);}, 1);}, 1)
    }, 0);
    
    $def(self, '$~', function $Regexp_$$8() {
      var self = this;
      if ($gvars._ == null) $gvars._ = nil;

      return self['$=~']($gvars._)
    }, 0);
    
    $def(self, '$source', function $$source() {
      var self = this;

      return self.source;
    }, 0);
    
    $def(self, '$options', function $$options() {
      var self = this;

      
      if (self.uninitialized) {
        $Kernel.$raise($$$('TypeError'), "uninitialized Regexp")
      }
      var result = 0;
      // should be supported in IE6 according to https://msdn.microsoft.com/en-us/library/7f5z26w4(v=vs.94).aspx
      if (self.multiline) {
        result |= $$('MULTILINE');
      }
      if (self.ignoreCase) {
        result |= $$('IGNORECASE');
      }
      return result;
    
    }, 0);
    
    $def(self, '$casefold?', function $Regexp_casefold$ques$9() {
      var self = this;

      return self.ignoreCase;
    }, 0);
    $alias(self, "eql?", "==");
    return $alias(self, "to_s", "source");
  })('::', RegExp, $nesting);
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'MatchData');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.matches = nil;
    
    self.$attr_reader("post_match", "pre_match", "regexp", "string");
    
    $def(self, '$initialize', function $$initialize(regexp, match_groups, $kwargs) {
      var no_matchdata, self = this;

      
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      no_matchdata = $kwargs.$$smap["no_matchdata"];
      if (no_matchdata == null) no_matchdata = false;
      if (!$truthy(no_matchdata)) {
        $gvars["~"] = self
      };
      self.regexp = regexp;
      self.begin = match_groups.index;
      self.string = match_groups.input;
      self.pre_match = match_groups.input.slice(0, match_groups.index);
      self.post_match = match_groups.input.slice(match_groups.index + match_groups[0].length);
      self.matches = [];
      
      for (var i = 0, length = match_groups.length; i < length; i++) {
        var group = match_groups[i];

        if (group == null) {
          self.matches.push(nil);
        }
        else {
          self.matches.push(group);
        }
      }
    ;
    }, -3);
    
    $def(self, '$match', function $$match(idx) {
      var self = this, match = nil;

      if ($truthy((match = self['$[]'](idx)))) {
        return match
      } else if (($truthy(idx['$is_a?']($$('Integer'))) && ($truthy($rb_ge(idx, self.$length()))))) {
        return $Kernel.$raise($$$('IndexError'), "index " + (idx) + " out of matches")
      } else {
        return nil
      }
    }, 1);
    
    $def(self, '$match_length', function $$match_length(idx) {
      var $a, self = this;

      return ($a = self.$match(idx), ($a === nil || $a == null) ? nil : self.$match(idx).$length())
    }, 1);
    
    $def(self, '$[]', function $MatchData_$$$10($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      if (args[0].$$is_string) {
        if (self.$regexp().$names()['$include?'](args['$[]'](0))['$!']()) {
          $Kernel.$raise($$$('IndexError'), "undefined group name reference: " + (args['$[]'](0)))
        }
        return self.$named_captures()['$[]'](args['$[]'](0))
      }
      else {
        return $send(self.matches, '[]', $to_a(args))
      }
    ;
    }, -1);
    
    $def(self, '$offset', function $$offset(n) {
      var self = this;

      
      if (n !== 0) {
        $Kernel.$raise($$$('ArgumentError'), "MatchData#offset only supports 0th element")
      }
      return [self.begin, self.begin + self.matches[n].length];
    
    }, 1);
    
    $def(self, '$==', function $MatchData_$eq_eq$11(other) {
      var self = this, $ret_or_1 = nil, $ret_or_2 = nil, $ret_or_3 = nil, $ret_or_4 = nil;

      
      if (!$eqeqeq($$$('MatchData'), other)) {
        return false
      };
      if ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = ($truthy(($ret_or_3 = ($truthy(($ret_or_4 = self.string == other.string)) ? (self.regexp.toString() == other.regexp.toString()) : ($ret_or_4)))) ? (self.pre_match == other.pre_match) : ($ret_or_3)))) ? (self.post_match == other.post_match) : ($ret_or_2))))) {
        return self.begin == other.begin;
      } else {
        return $ret_or_1
      };
    }, 1);
    
    $def(self, '$begin', function $$begin(n) {
      var self = this;

      
      if (n !== 0) {
        $Kernel.$raise($$$('ArgumentError'), "MatchData#begin only supports 0th element")
      }
      return self.begin;
    
    }, 1);
    
    $def(self, '$end', function $$end(n) {
      var self = this;

      
      if (n !== 0) {
        $Kernel.$raise($$$('ArgumentError'), "MatchData#end only supports 0th element")
      }
      return self.begin + self.matches[n].length;
    
    }, 1);
    
    $def(self, '$captures', function $$captures() {
      var self = this;

      return self.matches.slice(1)
    }, 0);
    
    $def(self, '$named_captures', function $$named_captures() {
      var self = this, matches = nil;

      
      matches = self.$captures();
      return $send(self.$regexp().$named_captures(), 'transform_values', [], function $$12(i){
        
        
        if (i == null) i = nil;;
        return matches['$[]']($rb_minus(i.$last(), 1));}, 1);
    }, 0);
    
    $def(self, '$names', function $$names() {
      var self = this;

      return self.$regexp().$names()
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      
      var str = "#<MatchData " + (self.matches[0]).$inspect();

      if (self.$regexp().$names()['$empty?']()) {
        for (var i = 1, length = self.matches.length; i < length; i++) {
          str += " " + i + ":" + (self.matches[i]).$inspect();
        }
      }
      else {
        $send(self.$named_captures(), 'each', [], function $$13(k, v){
        
        
        if (k == null) k = nil;;
        
        if (v == null) v = nil;;
        return                str += " " + k + ":" + v.$inspect();}, 2)
      }

      return str + ">";
    
    }, 0);
    
    $def(self, '$length', function $$length() {
      var self = this;

      return self.matches.length
    }, 0);
    
    $def(self, '$to_a', $return_ivar("matches"), 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this;

      return self.matches[0]
    }, 0);
    
    $def(self, '$values_at', function $$values_at($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var i, a, index, values = [];

      for (i = 0; i < args.length; i++) {

        if (args[i].$$is_range) {
          a = (args[i]).$to_a();
          a.unshift(i, 1);
          Array.prototype.splice.apply(args, a);
        }

        index = $Opal['$coerce_to!'](args[i], $$$('Integer'), "to_int");

        if (index < 0) {
          index += self.matches.length;
          if (index < 0) {
            values.push(nil);
            continue;
          }
        }

        values.push(self.matches[index]);
      }

      return values;
    ;
    }, -1);
    $alias(self, "eql?", "==");
    return $alias(self, "size", "length");
  })($nesting[0], null, $nesting);
};

Opal.modules["corelib/string"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $$$ = Opal.$$$, $coerce_to = Opal.coerce_to, $respond_to = Opal.respond_to, $global_multiline_regexp = Opal.global_multiline_regexp, $klass = Opal.klass, $def = Opal.def, $Opal = Opal.Opal, $defs = Opal.defs, $send = Opal.send, $to_a = Opal.to_a, $hash2 = Opal.hash2, $eqeqeq = Opal.eqeqeq, $Kernel = Opal.Kernel, $truthy = Opal.truthy, $gvars = Opal.gvars, $rb_divide = Opal.rb_divide, $rb_plus = Opal.rb_plus, $alias = Opal.alias, $const_set = Opal.const_set;

  Opal.add_stubs('require,include,coerce_to?,initialize,===,format,raise,respond_to?,to_s,to_str,<=>,==,=~,new,force_encoding,casecmp,empty?,ljust,ceil,/,+,rjust,floor,coerce_to!,copy_singleton_methods,initialize_clone,initialize_dup,enum_for,chomp,[],to_i,each_line,to_proc,to_a,class,match,match?,captures,proc,succ,escape,include?,upcase,unicode_normalize,dup,__id__,next,intern,pristine');
  
  self.$require("corelib/comparable");
  self.$require("corelib/regexp");
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'String');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    self.$include($$$('Comparable'));
    
    Opal.prop(self.$$prototype, '$$is_string', true);
  ;
    
    $def(self, '$__id__', function $$__id__() {
      var self = this;

      return self.toString();
    }, 0);
    $defs(self, '$try_convert', function $$try_convert(what) {
      
      return $Opal['$coerce_to?'](what, $$$('String'), "to_str")
    }, 1);
    $defs(self, '$new', function $String_new$1($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var str = args[0] || "";
      var opts = args[args.length-1];
      str = $coerce_to(str, $$$('String'), 'to_str');
      if (opts && opts.$$is_hash) {
        if (opts.$$smap.encoding) str = str.$force_encoding(opts.$$smap.encoding);
      }
      str = new self.$$constructor(str);
      if (!str.$initialize.$$pristine) $send((str), 'initialize', $to_a(args));
      return str;
    ;
    }, -1);
    
    $def(self, '$initialize', function $$initialize($a, $b) {
      var $post_args, $kwargs, str, encoding, capacity;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $kwargs = Opal.extract_kwargs($post_args);
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      if ($post_args.length > 0) str = $post_args.shift();;
      
      encoding = $kwargs.$$smap["encoding"];
      if (encoding == null) encoding = nil;
      
      capacity = $kwargs.$$smap["capacity"];
      if (capacity == null) capacity = nil;
      return nil;
    }, -1);
    
    $def(self, '$%', function $String_$percent$2(data) {
      var self = this;

      if ($eqeqeq($$$('Array'), data)) {
        return $send(self, 'format', [self].concat($to_a(data)))
      } else {
        return self.$format(self, data)
      }
    }, 1);
    
    $def(self, '$*', function $String_$$3(count) {
      var self = this;

      
      count = $coerce_to(count, $$$('Integer'), 'to_int');

      if (count < 0) {
        $Kernel.$raise($$$('ArgumentError'), "negative argument")
      }

      if (count === 0) {
        return '';
      }

      var result = '',
          string = self.toString();

      // All credit for the bit-twiddling magic code below goes to Mozilla
      // polyfill implementation of String.prototype.repeat() posted here:
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/repeat

      if (string.length * count >= 1 << 28) {
        $Kernel.$raise($$$('RangeError'), "multiply count must not overflow maximum string size")
      }

      for (;;) {
        if ((count & 1) === 1) {
          result += string;
        }
        count >>>= 1;
        if (count === 0) {
          break;
        }
        string += string;
      }

      return result;
    
    }, 1);
    
    $def(self, '$+', function $String_$plus$4(other) {
      var self = this;

      
      other = $coerce_to(other, $$$('String'), 'to_str');
      
      if (other == "" && self.$$class === Opal.String) return self;
      if (self == "" && other.$$class === Opal.String) return other;
      var out = self + other;
      if (self.encoding === out.encoding && other.encoding === out.encoding) return out;
      if (self.encoding.name === "UTF-8" || other.encoding.name === "UTF-8") return out;
      return Opal.enc(out, self.encoding);
    ;
    }, 1);
    
    $def(self, '$<=>', function $String_$lt_eq_gt$5(other) {
      var self = this;

      if ($truthy(other['$respond_to?']("to_str"))) {
        
        other = other.$to_str().$to_s();
        return self > other ? 1 : (self < other ? -1 : 0);;
      } else {
        
        var cmp = other['$<=>'](self);

        if (cmp === nil) {
          return nil;
        }
        else {
          return cmp > 0 ? -1 : (cmp < 0 ? 1 : 0);
        }
      
      }
    }, 1);
    
    $def(self, '$==', function $String_$eq_eq$6(other) {
      var self = this;

      
      if (other.$$is_string) {
        return self.toString() === other.toString();
      }
      if ($respond_to(other, '$to_str')) {
        return other['$=='](self);
      }
      return false;
    
    }, 1);
    
    $def(self, '$=~', function $String_$eq_tilde$7(other) {
      var self = this;

      
      if (other.$$is_string) {
        $Kernel.$raise($$$('TypeError'), "type mismatch: String given");
      }

      return other['$=~'](self);
    
    }, 1);
    
    $def(self, '$[]', function $String_$$$8(index, length) {
      var self = this;

      
      ;
      
      var size = self.length, exclude, range;

      if (index.$$is_range) {
        exclude = index.excl;
        range   = index;
        length  = index.end === nil ? -1 : $coerce_to(index.end, $$$('Integer'), 'to_int');
        index   = index.begin === nil ? 0 : $coerce_to(index.begin, $$$('Integer'), 'to_int');

        if (Math.abs(index) > size) {
          return nil;
        }

        if (index < 0) {
          index += size;
        }

        if (length < 0) {
          length += size;
        }

        if (!exclude || range.end === nil) {
          length += 1;
        }

        length = length - index;

        if (length < 0) {
          length = 0;
        }

        return self.substr(index, length);
      }


      if (index.$$is_string) {
        if (length != null) {
          $Kernel.$raise($$$('TypeError'))
        }
        return self.indexOf(index) !== -1 ? index : nil;
      }


      if (index.$$is_regexp) {
        var match = self.match(index);

        if (match === null) {
          ($gvars["~"] = nil)
          return nil;
        }

        ($gvars["~"] = $$$('MatchData').$new(index, match))

        if (length == null) {
          return match[0];
        }

        length = $coerce_to(length, $$$('Integer'), 'to_int');

        if (length < 0 && -length < match.length) {
          return match[length += match.length];
        }

        if (length >= 0 && length < match.length) {
          return match[length];
        }

        return nil;
      }


      index = $coerce_to(index, $$$('Integer'), 'to_int');

      if (index < 0) {
        index += size;
      }

      if (length == null) {
        if (index >= size || index < 0) {
          return nil;
        }
        return self.substr(index, 1);
      }

      length = $coerce_to(length, $$$('Integer'), 'to_int');

      if (length < 0) {
        return nil;
      }

      if (index > size || index < 0) {
        return nil;
      }

      return self.substr(index, length);
    ;
    }, -2);
    
    $def(self, '$b', function $$b() {
      var self = this;

      return (new String(self)).$force_encoding("binary")
    }, 0);
    
    $def(self, '$capitalize', function $$capitalize() {
      var self = this;

      return self.charAt(0).toUpperCase() + self.substr(1).toLowerCase();
    }, 0);
    
    $def(self, '$casecmp', function $$casecmp(other) {
      var self = this;

      
      if (!$truthy(other['$respond_to?']("to_str"))) {
        return nil
      };
      other = ($coerce_to(other, $$$('String'), 'to_str')).$to_s();
      
      var ascii_only = /^[\x00-\x7F]*$/;
      if (ascii_only.test(self) && ascii_only.test(other)) {
        self = self.toLowerCase();
        other = other.toLowerCase();
      }
    ;
      return self['$<=>'](other);
    }, 1);
    
    $def(self, '$casecmp?', function $String_casecmp$ques$9(other) {
      var self = this;

      
      var cmp = self.$casecmp(other);
      if (cmp === nil) {
        return nil;
      } else {
        return cmp === 0;
      }
    
    }, 1);
    
    $def(self, '$center', function $$center(width, padstr) {
      var self = this;

      
      
      if (padstr == null) padstr = " ";;
      width = $coerce_to(width, $$$('Integer'), 'to_int');
      padstr = ($coerce_to(padstr, $$$('String'), 'to_str')).$to_s();
      if ($truthy(padstr['$empty?']())) {
        $Kernel.$raise($$$('ArgumentError'), "zero width padding")
      };
      if ($truthy(width <= self.length)) {
        return self
      };
      
      var ljustified = self.$ljust($rb_divide($rb_plus(width, self.length), 2).$ceil(), padstr),
          rjustified = self.$rjust($rb_divide($rb_plus(width, self.length), 2).$floor(), padstr);

      return rjustified + ljustified.slice(self.length);
    ;
    }, -2);
    
    $def(self, '$chomp', function $$chomp(separator) {
      var self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      
      
      if (separator == null) separator = $gvars["/"];;
      if ($truthy(separator === nil || self.length === 0)) {
        return self
      };
      separator = $Opal['$coerce_to!'](separator, $$$('String'), "to_str").$to_s();
      
      var result;

      if (separator === "\n") {
        result = self.replace(/\r?\n?$/, '');
      }
      else if (separator === "") {
        result = self.replace(/(\r?\n)+$/, '');
      }
      else if (self.length >= separator.length) {
        var tail = self.substr(self.length - separator.length, separator.length);

        if (tail === separator) {
          result = self.substr(0, self.length - separator.length);
        }
      }

      if (result != null) {
        return result;
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$chop', function $$chop() {
      var self = this;

      
      var length = self.length, result;

      if (length <= 1) {
        result = "";
      } else if (self.charAt(length - 1) === "\n" && self.charAt(length - 2) === "\r") {
        result = self.substr(0, length - 2);
      } else {
        result = self.substr(0, length - 1);
      }

      return result;
    
    }, 0);
    
    $def(self, '$chr', function $$chr() {
      var self = this;

      return self.charAt(0);
    }, 0);
    
    $def(self, '$clone', function $$clone() {
      var self = this, copy = nil;

      
      copy = new String(self);
      copy.$copy_singleton_methods(self);
      copy.$initialize_clone(self);
      return copy;
    }, 0);
    
    $def(self, '$dup', function $$dup() {
      var self = this, copy = nil;

      
      copy = new String(self);
      copy.$initialize_dup(self);
      return copy;
    }, 0);
    
    $def(self, '$count', function $$count($a) {
      var $post_args, sets, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      sets = $post_args;;
      
      if (sets.length === 0) {
        $Kernel.$raise($$$('ArgumentError'), "ArgumentError: wrong number of arguments (0 for 1+)")
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return 0;
      }
      return self.length - self.replace(new RegExp(char_class, 'g'), '').length;
    ;
    }, -1);
    
    $def(self, '$delete', function $String_delete$10($a) {
      var $post_args, sets, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      sets = $post_args;;
      
      if (sets.length === 0) {
        $Kernel.$raise($$$('ArgumentError'), "ArgumentError: wrong number of arguments (0 for 1+)")
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return self;
      }
      return self.replace(new RegExp(char_class, 'g'), '');
    ;
    }, -1);
    
    $def(self, '$delete_prefix', function $$delete_prefix(prefix) {
      var self = this;

      
      if (!prefix.$$is_string) {
        prefix = $coerce_to(prefix, $$$('String'), 'to_str');
      }

      if (self.slice(0, prefix.length) === prefix) {
        return self.slice(prefix.length);
      } else {
        return self;
      }
    
    }, 1);
    
    $def(self, '$delete_suffix', function $$delete_suffix(suffix) {
      var self = this;

      
      if (!suffix.$$is_string) {
        suffix = $coerce_to(suffix, $$$('String'), 'to_str');
      }

      if (self.slice(self.length - suffix.length) === suffix) {
        return self.slice(0, self.length - suffix.length);
      } else {
        return self;
      }
    
    }, 1);
    
    $def(self, '$downcase', function $$downcase() {
      var self = this;

      return self.toLowerCase();
    }, 0);
    
    $def(self, '$each_line', function $$each_line($a, $b) {
      var block = $$each_line.$$p || nil, $post_args, $kwargs, separator, chomp, self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      delete $$each_line.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      $kwargs = Opal.extract_kwargs($post_args);
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      if ($post_args.length > 0) separator = $post_args.shift();
      if (separator == null) separator = $gvars["/"];;
      
      chomp = $kwargs.$$smap["chomp"];
      if (chomp == null) chomp = false;
      if (!(block !== nil)) {
        return self.$enum_for("each_line", separator, $hash2(["chomp"], {"chomp": chomp}))
      };
      
      if (separator === nil) {
        Opal.yield1(block, self);

        return self;
      }

      separator = $coerce_to(separator, $$$('String'), 'to_str');

      var a, i, n, length, chomped, trailing, splitted, value;

      if (separator.length === 0) {
        for (a = self.split(/((?:\r?\n){2})(?:(?:\r?\n)*)/), i = 0, n = a.length; i < n; i += 2) {
          if (a[i] || a[i + 1]) {
            value = (a[i] || "") + (a[i + 1] || "");
            if (chomp) {
              value = (value).$chomp("\n");
            }
            Opal.yield1(block, value);
          }
        }

        return self;
      }

      chomped  = self.$chomp(separator);
      trailing = self.length != chomped.length;
      splitted = chomped.split(separator);

      for (i = 0, length = splitted.length; i < length; i++) {
        value = splitted[i];
        if (i < length - 1 || trailing) {
          value += separator;
        }
        if (chomp) {
          value = (value).$chomp(separator);
        }
        Opal.yield1(block, value);
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$empty?', function $String_empty$ques$11() {
      var self = this;

      return self.length === 0;
    }, 0);
    
    $def(self, '$end_with?', function $String_end_with$ques$12($a) {
      var $post_args, suffixes, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      suffixes = $post_args;;
      
      for (var i = 0, length = suffixes.length; i < length; i++) {
        var suffix = $coerce_to(suffixes[i], $$$('String'), 'to_str').$to_s();

        if (self.length >= suffix.length &&
            self.substr(self.length - suffix.length, suffix.length) == suffix) {
          return true;
        }
      }
    ;
      return false;
    }, -1);
    
    $def(self, '$gsub', function $$gsub(pattern, replacement) {
      var block = $$gsub.$$p || nil, self = this;

      delete $$gsub.$$p;
      
      ;
      ;
      
      if (replacement === undefined && block === nil) {
        return self.$enum_for("gsub", pattern);
      }

      var result = '', match_data = nil, index = 0, match, _replacement;

      if (pattern.$$is_regexp) {
        pattern = $global_multiline_regexp(pattern);
      } else {
        pattern = $coerce_to(pattern, $$$('String'), 'to_str');
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
      }

      var lastIndex;
      while (true) {
        match = pattern.exec(self);

        if (match === null) {
          ($gvars["~"] = nil)
          result += self.slice(index);
          break;
        }

        match_data = $$$('MatchData').$new(pattern, match);

        if (replacement === undefined) {
          lastIndex = pattern.lastIndex;
          _replacement = block(match[0]);
          pattern.lastIndex = lastIndex; // save and restore lastIndex
        }
        else if (replacement.$$is_hash) {
          _replacement = (replacement)['$[]'](match[0]).$to_s();
        }
        else {
          if (!replacement.$$is_string) {
            replacement = $coerce_to(replacement, $$$('String'), 'to_str');
          }
          _replacement = replacement.replace(/([\\]+)([0-9+&`'])/g, function (original, slashes, command) {
            if (slashes.length % 2 === 0) {
              return original;
            }
            switch (command) {
            case "+":
              for (var i = match.length - 1; i > 0; i--) {
                if (match[i] !== undefined) {
                  return slashes.slice(1) + match[i];
                }
              }
              return '';
            case "&": return slashes.slice(1) + match[0];
            case "`": return slashes.slice(1) + self.slice(0, match.index);
            case "'": return slashes.slice(1) + self.slice(match.index + match[0].length);
            default:  return slashes.slice(1) + (match[command] || '');
            }
          }).replace(/\\\\/g, '\\');
        }

        if (pattern.lastIndex === match.index) {
          result += (self.slice(index, match.index) + _replacement + (self[match.index] || ""));
          pattern.lastIndex += 1;
        }
        else {
          result += (self.slice(index, match.index) + _replacement)
        }
        index = pattern.lastIndex;
      }

      ($gvars["~"] = match_data)
      return result;
    ;
    }, -2);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      return self.toString();
    }, 0);
    
    $def(self, '$hex', function $$hex() {
      var self = this;

      return self.$to_i(16)
    }, 0);
    
    $def(self, '$include?', function $String_include$ques$13(other) {
      var self = this;

      
      if (!other.$$is_string) {
        other = $coerce_to(other, $$$('String'), 'to_str');
      }
      return self.indexOf(other) !== -1;
    
    }, 1);
    
    $def(self, '$index', function $$index(search, offset) {
      var self = this;

      
      ;
      
      var index,
          match,
          regex;

      if (offset === undefined) {
        offset = 0;
      } else {
        offset = $coerce_to(offset, $$$('Integer'), 'to_int');
        if (offset < 0) {
          offset += self.length;
          if (offset < 0) {
            return nil;
          }
        }
      }

      if (search.$$is_regexp) {
        regex = $global_multiline_regexp(search);
        while (true) {
          match = regex.exec(self);
          if (match === null) {
            ($gvars["~"] = nil);
            index = -1;
            break;
          }
          if (match.index >= offset) {
            ($gvars["~"] = $$$('MatchData').$new(regex, match))
            index = match.index;
            break;
          }
          regex.lastIndex = match.index + 1;
        }
      } else {
        search = $coerce_to(search, $$$('String'), 'to_str');
        if (search.length === 0 && offset > self.length) {
          index = -1;
        } else {
          index = self.indexOf(search, offset);
        }
      }

      return index === -1 ? nil : index;
    ;
    }, -2);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      
      /* eslint-disable no-misleading-character-class */
      var escapable = /[\\\"\x00-\x1f\u007F-\u009F\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
          meta = {
            '\u0007': '\\a',
            '\u001b': '\\e',
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '\v': '\\v',
            '"' : '\\"',
            '\\': '\\\\'
          },
          escaped = self.replace(escapable, function (chr) {
            if (meta[chr]) return meta[chr];
            chr = chr.charCodeAt(0);
            if (chr <= 0xff && (self.encoding["$binary?"]() || self.internal_encoding["$binary?"]())) {
              return '\\x' + ('00' + chr.toString(16).toUpperCase()).slice(-2);
            } else {
              return '\\u' + ('0000' + chr.toString(16).toUpperCase()).slice(-4);
            }
          });
      return '"' + escaped.replace(/\#[\$\@\{]/g, '\\$&') + '"';
      /* eslint-enable no-misleading-character-class */
    
    }, 0);
    
    $def(self, '$intern', function $$intern() {
      var self = this;

      return self.toString();
    }, 0);
    
    $def(self, '$lines', function $$lines($a, $b) {
      var block = $$lines.$$p || nil, $post_args, $kwargs, separator, chomp, self = this, e = nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      delete $$lines.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      $kwargs = Opal.extract_kwargs($post_args);
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      if ($post_args.length > 0) separator = $post_args.shift();
      if (separator == null) separator = $gvars["/"];;
      
      chomp = $kwargs.$$smap["chomp"];
      if (chomp == null) chomp = false;
      e = $send(self, 'each_line', [separator, $hash2(["chomp"], {"chomp": chomp})], block.$to_proc());
      if ($truthy(block)) {
        return self
      } else {
        return e.$to_a()
      };
    }, -1);
    
    $def(self, '$ljust', function $$ljust(width, padstr) {
      var self = this;

      
      
      if (padstr == null) padstr = " ";;
      width = $coerce_to(width, $$$('Integer'), 'to_int');
      padstr = ($coerce_to(padstr, $$$('String'), 'to_str')).$to_s();
      if ($truthy(padstr['$empty?']())) {
        $Kernel.$raise($$$('ArgumentError'), "zero width padding")
      };
      if ($truthy(width <= self.length)) {
        return self
      };
      
      var index  = -1,
          result = "";

      width -= self.length;

      while (++index < width) {
        result += padstr;
      }

      return self + result.slice(0, width);
    ;
    }, -2);
    
    $def(self, '$lstrip', function $$lstrip() {
      var self = this;

      return self.replace(/^[\u0000\s]*/, '');
    }, 0);
    
    $def(self, '$ascii_only?', function $String_ascii_only$ques$14() {
      var self = this;

      
      if (!self.encoding.ascii) return false;
      return /^[\x00-\x7F]*$/.test(self);
    
    }, 0);
    
    $def(self, '$match', function $$match(pattern, pos) {
      var block = $$match.$$p || nil, self = this;

      delete $$match.$$p;
      
      ;
      ;
      if (($eqeqeq($$('String'), pattern) || ($truthy(pattern['$respond_to?']("to_str"))))) {
        pattern = $$$('Regexp').$new(pattern.$to_str())
      };
      if (!$eqeqeq($$$('Regexp'), pattern)) {
        $Kernel.$raise($$$('TypeError'), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      return $send(pattern, 'match', [self, pos], block.$to_proc());
    }, -2);
    
    $def(self, '$match?', function $String_match$ques$15(pattern, pos) {
      var self = this;

      
      ;
      if (($eqeqeq($$('String'), pattern) || ($truthy(pattern['$respond_to?']("to_str"))))) {
        pattern = $$$('Regexp').$new(pattern.$to_str())
      };
      if (!$eqeqeq($$$('Regexp'), pattern)) {
        $Kernel.$raise($$$('TypeError'), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      return pattern['$match?'](self, pos);
    }, -2);
    
    $def(self, '$next', function $$next() {
      var self = this;

      
      var i = self.length;
      if (i === 0) {
        return '';
      }
      var result = self;
      var first_alphanum_char_index = self.search(/[a-zA-Z0-9]/);
      var carry = false;
      var code;
      while (i--) {
        code = self.charCodeAt(i);
        if ((code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122)) {
          switch (code) {
          case 57:
            carry = true;
            code = 48;
            break;
          case 90:
            carry = true;
            code = 65;
            break;
          case 122:
            carry = true;
            code = 97;
            break;
          default:
            carry = false;
            code += 1;
          }
        } else {
          if (first_alphanum_char_index === -1) {
            if (code === 255) {
              carry = true;
              code = 0;
            } else {
              carry = false;
              code += 1;
            }
          } else {
            carry = true;
          }
        }
        result = result.slice(0, i) + String.fromCharCode(code) + result.slice(i + 1);
        if (carry && (i === 0 || i === first_alphanum_char_index)) {
          switch (code) {
          case 65:
            break;
          case 97:
            break;
          default:
            code += 1;
          }
          if (i === 0) {
            result = String.fromCharCode(code) + result;
          } else {
            result = result.slice(0, i) + String.fromCharCode(code) + result.slice(i);
          }
          carry = false;
        }
        if (!carry) {
          break;
        }
      }
      return result;
    
    }, 0);
    
    $def(self, '$oct', function $$oct() {
      var self = this;

      
      var result,
          string = self,
          radix = 8;

      if (/^\s*_/.test(string)) {
        return 0;
      }

      string = string.replace(/^(\s*[+-]?)(0[bodx]?)(.+)$/i, function (original, head, flag, tail) {
        switch (tail.charAt(0)) {
        case '+':
        case '-':
          return original;
        case '0':
          if (tail.charAt(1) === 'x' && flag === '0x') {
            return original;
          }
        }
        switch (flag) {
        case '0b':
          radix = 2;
          break;
        case '0':
        case '0o':
          radix = 8;
          break;
        case '0d':
          radix = 10;
          break;
        case '0x':
          radix = 16;
          break;
        }
        return head + tail;
      });

      result = parseInt(string.replace(/_(?!_)/g, ''), radix);
      return isNaN(result) ? 0 : result;
    
    }, 0);
    
    $def(self, '$ord', function $$ord() {
      var self = this;

      
      if (typeof self.codePointAt === "function") {
        return self.codePointAt(0);
      }
      else {
        return self.charCodeAt(0);
      }
    
    }, 0);
    
    $def(self, '$partition', function $$partition(sep) {
      var self = this;

      
      var i, m;

      if (sep.$$is_regexp) {
        m = sep.exec(self);
        if (m === null) {
          i = -1;
        } else {
          $$$('MatchData').$new(sep, m);
          sep = m[0];
          i = m.index;
        }
      } else {
        sep = $coerce_to(sep, $$$('String'), 'to_str');
        i = self.indexOf(sep);
      }

      if (i === -1) {
        return [self, '', ''];
      }

      return [
        self.slice(0, i),
        self.slice(i, i + sep.length),
        self.slice(i + sep.length)
      ];
    
    }, 1);
    
    $def(self, '$reverse', function $$reverse() {
      var self = this;

      return self.split('').reverse().join('');
    }, 0);
    
    $def(self, '$rindex', function $$rindex(search, offset) {
      var self = this;

      
      ;
      
      var i, m, r, _m;

      if (offset === undefined) {
        offset = self.length;
      } else {
        offset = $coerce_to(offset, $$$('Integer'), 'to_int');
        if (offset < 0) {
          offset += self.length;
          if (offset < 0) {
            return nil;
          }
        }
      }

      if (search.$$is_regexp) {
        m = null;
        r = $global_multiline_regexp(search);
        while (true) {
          _m = r.exec(self);
          if (_m === null || _m.index > offset) {
            break;
          }
          m = _m;
          r.lastIndex = m.index + 1;
        }
        if (m === null) {
          ($gvars["~"] = nil)
          i = -1;
        } else {
          $$$('MatchData').$new(r, m);
          i = m.index;
        }
      } else {
        search = $coerce_to(search, $$$('String'), 'to_str');
        i = self.lastIndexOf(search, offset);
      }

      return i === -1 ? nil : i;
    ;
    }, -2);
    
    $def(self, '$rjust', function $$rjust(width, padstr) {
      var self = this;

      
      
      if (padstr == null) padstr = " ";;
      width = $coerce_to(width, $$$('Integer'), 'to_int');
      padstr = ($coerce_to(padstr, $$$('String'), 'to_str')).$to_s();
      if ($truthy(padstr['$empty?']())) {
        $Kernel.$raise($$$('ArgumentError'), "zero width padding")
      };
      if ($truthy(width <= self.length)) {
        return self
      };
      
      var chars     = Math.floor(width - self.length),
          patterns  = Math.floor(chars / padstr.length),
          result    = Array(patterns + 1).join(padstr),
          remaining = chars - result.length;

      return result + padstr.slice(0, remaining) + self;
    ;
    }, -2);
    
    $def(self, '$rpartition', function $$rpartition(sep) {
      var self = this;

      
      var i, m, r, _m;

      if (sep.$$is_regexp) {
        m = null;
        r = $global_multiline_regexp(sep);

        while (true) {
          _m = r.exec(self);
          if (_m === null) {
            break;
          }
          m = _m;
          r.lastIndex = m.index + 1;
        }

        if (m === null) {
          i = -1;
        } else {
          $$$('MatchData').$new(r, m);
          sep = m[0];
          i = m.index;
        }

      } else {
        sep = $coerce_to(sep, $$$('String'), 'to_str');
        i = self.lastIndexOf(sep);
      }

      if (i === -1) {
        return ['', '', self];
      }

      return [
        self.slice(0, i),
        self.slice(i, i + sep.length),
        self.slice(i + sep.length)
      ];
    
    }, 1);
    
    $def(self, '$rstrip', function $$rstrip() {
      var self = this;

      return self.replace(/[\s\u0000]*$/, '');
    }, 0);
    
    $def(self, '$scan', function $$scan(pattern, $kwargs) {
      var block = $$scan.$$p || nil, no_matchdata, self = this;

      delete $$scan.$$p;
      
      ;
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      no_matchdata = $kwargs.$$smap["no_matchdata"];
      if (no_matchdata == null) no_matchdata = false;
      
      var result = [],
          match_data = nil,
          match;

      if (pattern.$$is_regexp) {
        pattern = $global_multiline_regexp(pattern);
      } else {
        pattern = $coerce_to(pattern, $$$('String'), 'to_str');
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
      }

      while ((match = pattern.exec(self)) != null) {
        match_data = $$$('MatchData').$new(pattern, match, $hash2(["no_matchdata"], {"no_matchdata": no_matchdata}));
        if (block === nil) {
          match.length == 1 ? result.push(match[0]) : result.push((match_data).$captures());
        } else {
          match.length == 1 ? Opal.yield1(block, match[0]) : Opal.yield1(block, (match_data).$captures());
        }
        if (pattern.lastIndex === match.index) {
          pattern.lastIndex += 1;
        }
      }

      if (!no_matchdata) ($gvars["~"] = match_data);

      return (block !== nil ? self : result);
    ;
    }, -2);
    
    $def(self, '$singleton_class', function $$singleton_class() {
      var self = this;

      return Opal.get_singleton_class(self);
    }, 0);
    
    $def(self, '$split', function $$split(pattern, limit) {
      var self = this, $ret_or_1 = nil;
      if ($gvars[";"] == null) $gvars[";"] = nil;

      
      ;
      ;
      
      if (self.length === 0) {
        return [];
      }

      if (limit === undefined) {
        limit = 0;
      } else {
        limit = $Opal['$coerce_to!'](limit, $$$('Integer'), "to_int");
        if (limit === 1) {
          return [self];
        }
      }

      if (pattern === undefined || pattern === nil) {
        pattern = ($truthy(($ret_or_1 = $gvars[";"])) ? ($ret_or_1) : (" "));
      }

      var result = [],
          string = self.toString(),
          index = 0,
          match,
          i, ii;

      if (pattern.$$is_regexp) {
        pattern = $global_multiline_regexp(pattern);
      } else {
        pattern = $coerce_to(pattern, $$$('String'), 'to_str').$to_s();
        if (pattern === ' ') {
          pattern = /\s+/gm;
          string = string.replace(/^\s+/, '');
        } else {
          pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
        }
      }

      result = string.split(pattern);

      if (result.length === 1 && result[0] === string) {
        return [result[0]];
      }

      while ((i = result.indexOf(undefined)) !== -1) {
        result.splice(i, 1);
      }

      if (limit === 0) {
        while (result[result.length - 1] === '') {
          result.length -= 1;
        }
        return result;
      }

      match = pattern.exec(string);

      if (limit < 0) {
        if (match !== null && match[0] === '' && pattern.source.indexOf('(?=') === -1) {
          for (i = 0, ii = match.length; i < ii; i++) {
            result.push('');
          }
        }
        return result;
      }

      if (match !== null && match[0] === '') {
        result.splice(limit - 1, result.length - 1, result.slice(limit - 1).join(''));
        return result;
      }

      if (limit >= result.length) {
        return result;
      }

      i = 0;
      while (match !== null) {
        i++;
        index = pattern.lastIndex;
        if (i + 1 === limit) {
          break;
        }
        match = pattern.exec(string);
      }
      result.splice(limit - 1, result.length - 1, string.slice(index));
      return result;
    ;
    }, -1);
    
    $def(self, '$squeeze', function $$squeeze($a) {
      var $post_args, sets, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      sets = $post_args;;
      
      if (sets.length === 0) {
        return self.replace(/(.)\1+/g, '$1');
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return self;
      }
      return self.replace(new RegExp('(' + char_class + ')\\1+', 'g'), '$1');
    ;
    }, -1);
    
    $def(self, '$start_with?', function $String_start_with$ques$16($a) {
      var $post_args, prefixes, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      prefixes = $post_args;;
      
      for (var i = 0, length = prefixes.length; i < length; i++) {
        if (prefixes[i].$$is_regexp) {
          var regexp = prefixes[i];
          var match = regexp.exec(self);

          if (match != null && match.index === 0) {
            ($gvars["~"] = $$$('MatchData').$new(regexp, match));
            return true;
          } else {
            ($gvars["~"] = nil)
          }
        } else {
          var prefix = $coerce_to(prefixes[i], $$$('String'), 'to_str').$to_s();

          if (self.indexOf(prefix) === 0) {
            return true;
          }
        }
      }

      return false;
    ;
    }, -1);
    
    $def(self, '$strip', function $$strip() {
      var self = this;

      return self.replace(/^[\s\u0000]*|[\s\u0000]*$/g, '');
    }, 0);
    
    $def(self, '$sub', function $$sub(pattern, replacement) {
      var block = $$sub.$$p || nil, self = this;

      delete $$sub.$$p;
      
      ;
      ;
      
      if (!pattern.$$is_regexp) {
        pattern = $coerce_to(pattern, $$$('String'), 'to_str');
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }

      var result, match = pattern.exec(self);

      if (match === null) {
        ($gvars["~"] = nil)
        result = self.toString();
      } else {
        $$$('MatchData').$new(pattern, match)

        if (replacement === undefined) {

          if (block === nil) {
            $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (1 for 2)")
          }
          result = self.slice(0, match.index) + block(match[0]) + self.slice(match.index + match[0].length);

        } else if (replacement.$$is_hash) {

          result = self.slice(0, match.index) + (replacement)['$[]'](match[0]).$to_s() + self.slice(match.index + match[0].length);

        } else {

          replacement = $coerce_to(replacement, $$$('String'), 'to_str');

          replacement = replacement.replace(/([\\]+)([0-9+&`'])/g, function (original, slashes, command) {
            if (slashes.length % 2 === 0) {
              return original;
            }
            switch (command) {
            case "+":
              for (var i = match.length - 1; i > 0; i--) {
                if (match[i] !== undefined) {
                  return slashes.slice(1) + match[i];
                }
              }
              return '';
            case "&": return slashes.slice(1) + match[0];
            case "`": return slashes.slice(1) + self.slice(0, match.index);
            case "'": return slashes.slice(1) + self.slice(match.index + match[0].length);
            default:  return slashes.slice(1) + (match[command] || '');
            }
          }).replace(/\\\\/g, '\\');

          result = self.slice(0, match.index) + replacement + self.slice(match.index + match[0].length);
        }
      }

      return result;
    ;
    }, -2);
    
    $def(self, '$sum', function $$sum(n) {
      var self = this;

      
      
      if (n == null) n = 16;;
      
      n = $coerce_to(n, $$$('Integer'), 'to_int');

      var result = 0,
          length = self.length,
          i = 0;

      for (; i < length; i++) {
        result += self.charCodeAt(i);
      }

      if (n <= 0) {
        return result;
      }

      return result & (Math.pow(2, n) - 1);
    ;
    }, -1);
    
    $def(self, '$swapcase', function $$swapcase() {
      var self = this;

      
      var str = self.replace(/([a-z]+)|([A-Z]+)/g, function($0,$1,$2) {
        return $1 ? $0.toUpperCase() : $0.toLowerCase();
      });

      return str;
    
    }, 0);
    
    $def(self, '$to_f', function $$to_f() {
      var self = this;

      
      if (self.charAt(0) === '_') {
        return 0;
      }

      var result = parseFloat(self.replace(/_/g, ''));

      if (isNaN(result) || result == Infinity || result == -Infinity) {
        return 0;
      }
      else {
        return result;
      }
    
    }, 0);
    
    $def(self, '$to_i', function $$to_i(base) {
      var self = this;

      
      
      if (base == null) base = 10;;
      
      var result,
          string = self.toLowerCase(),
          radix = $coerce_to(base, $$$('Integer'), 'to_int');

      if (radix === 1 || radix < 0 || radix > 36) {
        $Kernel.$raise($$$('ArgumentError'), "invalid radix " + (radix))
      }

      if (/^\s*_/.test(string)) {
        return 0;
      }

      string = string.replace(/^(\s*[+-]?)(0[bodx]?)(.+)$/, function (original, head, flag, tail) {
        switch (tail.charAt(0)) {
        case '+':
        case '-':
          return original;
        case '0':
          if (tail.charAt(1) === 'x' && flag === '0x' && (radix === 0 || radix === 16)) {
            return original;
          }
        }
        switch (flag) {
        case '0b':
          if (radix === 0 || radix === 2) {
            radix = 2;
            return head + tail;
          }
          break;
        case '0':
        case '0o':
          if (radix === 0 || radix === 8) {
            radix = 8;
            return head + tail;
          }
          break;
        case '0d':
          if (radix === 0 || radix === 10) {
            radix = 10;
            return head + tail;
          }
          break;
        case '0x':
          if (radix === 0 || radix === 16) {
            radix = 16;
            return head + tail;
          }
          break;
        }
        return original
      });

      result = parseInt(string.replace(/_(?!_)/g, ''), radix);
      return isNaN(result) ? 0 : result;
    ;
    }, -1);
    
    $def(self, '$to_proc', function $$to_proc() {
      var $yield = $$to_proc.$$p || nil, self = this, method_name = nil;

      delete $$to_proc.$$p;
      
      method_name = self.valueOf();
      return $send($Kernel, 'proc', [], function $$17($a){var block = $$17.$$p || nil, $post_args, args;

        delete $$17.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        
        if (args.length === 0) {
          $Kernel.$raise($$$('ArgumentError'), "no receiver given")
        }

        var recv = args[0];

        if (recv == null) recv = nil;

        var body = recv['$' + method_name];

        if (!body) {
          body = recv.$method_missing;
          args[0] = method_name;
        } else {
          args = args.slice(1);
        }

        if (typeof block === 'function') {
          body.$$p = block;
        }

        if (args.length === 0) {
          return body.call(recv);
        } else {
          return body.apply(recv, args);
        }
      ;}, -1);
    }, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this;

      return self.toString();
    }, 0);
    
    $def(self, '$tr', function $$tr(from, to) {
      var self = this;

      
      from = $coerce_to(from, $$$('String'), 'to_str').$to_s();
      to = $coerce_to(to, $$$('String'), 'to_str').$to_s();

      if (from.length == 0 || from === to) {
        return self;
      }

      var i, in_range, c, ch, start, end, length;
      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^' && from_chars.length > 1) {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      in_range = false;
      for (i = 0; i < from_length; i++) {
        ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          start = last_from.charCodeAt(0);
          end = ch.charCodeAt(0);
          if (start > end) {
            $Kernel.$raise($$$('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
          }
          for (c = start + 1; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          in_range = false;
          for (i = 0; i < to_length; i++) {
            ch = to_chars[i];
            if (last_to == null) {
              last_to = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              start = last_to.charCodeAt(0);
              end = ch.charCodeAt(0);
              if (start > end) {
                $Kernel.$raise($$$('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
              }
              for (c = start + 1; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_to = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }

      var new_str = ''
      for (i = 0, length = self.length; i < length; i++) {
        ch = self.charAt(i);
        var sub = subs[ch];
        if (inverse) {
          new_str += (sub == null ? global_sub : ch);
        }
        else {
          new_str += (sub != null ? sub : ch);
        }
      }
      return new_str;
    
    }, 2);
    
    $def(self, '$tr_s', function $$tr_s(from, to) {
      var self = this;

      
      from = $coerce_to(from, $$$('String'), 'to_str').$to_s();
      to = $coerce_to(to, $$$('String'), 'to_str').$to_s();

      if (from.length == 0) {
        return self;
      }

      var i, in_range, c, ch, start, end, length;
      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^' && from_chars.length > 1) {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      in_range = false;
      for (i = 0; i < from_length; i++) {
        ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          start = last_from.charCodeAt(0);
          end = ch.charCodeAt(0);
          if (start > end) {
            $Kernel.$raise($$$('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
          }
          for (c = start + 1; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          in_range = false;
          for (i = 0; i < to_length; i++) {
            ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              start = last_from.charCodeAt(0);
              end = ch.charCodeAt(0);
              if (start > end) {
                $Kernel.$raise($$$('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
              }
              for (c = start + 1; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }
      var new_str = ''
      var last_substitute = null
      for (i = 0, length = self.length; i < length; i++) {
        ch = self.charAt(i);
        var sub = subs[ch]
        if (inverse) {
          if (sub == null) {
            if (last_substitute == null) {
              new_str += global_sub;
              last_substitute = true;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
        else {
          if (sub != null) {
            if (last_substitute == null || last_substitute !== sub) {
              new_str += sub;
              last_substitute = sub;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
      }
      return new_str;
    
    }, 2);
    
    $def(self, '$upcase', function $$upcase() {
      var self = this;

      return self.toUpperCase();
    }, 0);
    
    $def(self, '$upto', function $$upto(stop, excl) {
      var block = $$upto.$$p || nil, self = this;

      delete $$upto.$$p;
      
      ;
      
      if (excl == null) excl = false;;
      if (!(block !== nil)) {
        return self.$enum_for("upto", stop, excl)
      };
      
      var a, b, s = self.toString();

      stop = $coerce_to(stop, $$$('String'), 'to_str');

      if (s.length === 1 && stop.length === 1) {

        a = s.charCodeAt(0);
        b = stop.charCodeAt(0);

        while (a <= b) {
          if (excl && a === b) {
            break;
          }

          block(String.fromCharCode(a));

          a += 1;
        }

      } else if (parseInt(s, 10).toString() === s && parseInt(stop, 10).toString() === stop) {

        a = parseInt(s, 10);
        b = parseInt(stop, 10);

        while (a <= b) {
          if (excl && a === b) {
            break;
          }

          block(a.toString());

          a += 1;
        }

      } else {

        while (s.length <= stop.length && s <= stop) {
          if (excl && s === stop) {
            break;
          }

          block(s);

          s = (s).$succ();
        }

      }
      return self;
    ;
    }, -2);
    
    function char_class_from_char_sets(sets) {
      function explode_sequences_in_character_set(set) {
        var result = '',
            i, len = set.length,
            curr_char,
            skip_next_dash,
            char_code_from,
            char_code_upto,
            char_code;
        for (i = 0; i < len; i++) {
          curr_char = set.charAt(i);
          if (curr_char === '-' && i > 0 && i < (len - 1) && !skip_next_dash) {
            char_code_from = set.charCodeAt(i - 1);
            char_code_upto = set.charCodeAt(i + 1);
            if (char_code_from > char_code_upto) {
              $Kernel.$raise($$$('ArgumentError'), "invalid range \"" + (char_code_from) + "-" + (char_code_upto) + "\" in string transliteration")
            }
            for (char_code = char_code_from + 1; char_code < char_code_upto + 1; char_code++) {
              result += String.fromCharCode(char_code);
            }
            skip_next_dash = true;
            i++;
          } else {
            skip_next_dash = (curr_char === '\\');
            result += curr_char;
          }
        }
        return result;
      }

      function intersection(setA, setB) {
        if (setA.length === 0) {
          return setB;
        }
        var result = '',
            i, len = setA.length,
            chr;
        for (i = 0; i < len; i++) {
          chr = setA.charAt(i);
          if (setB.indexOf(chr) !== -1) {
            result += chr;
          }
        }
        return result;
      }

      var i, len, set, neg, chr, tmp,
          pos_intersection = '',
          neg_intersection = '';

      for (i = 0, len = sets.length; i < len; i++) {
        set = $coerce_to(sets[i], $$$('String'), 'to_str');
        neg = (set.charAt(0) === '^' && set.length > 1);
        set = explode_sequences_in_character_set(neg ? set.slice(1) : set);
        if (neg) {
          neg_intersection = intersection(neg_intersection, set);
        } else {
          pos_intersection = intersection(pos_intersection, set);
        }
      }

      if (pos_intersection.length > 0 && neg_intersection.length > 0) {
        tmp = '';
        for (i = 0, len = pos_intersection.length; i < len; i++) {
          chr = pos_intersection.charAt(i);
          if (neg_intersection.indexOf(chr) === -1) {
            tmp += chr;
          }
        }
        pos_intersection = tmp;
        neg_intersection = '';
      }

      if (pos_intersection.length > 0) {
        return '[' + $$$('Regexp').$escape(pos_intersection) + ']';
      }

      if (neg_intersection.length > 0) {
        return '[^' + $$$('Regexp').$escape(neg_intersection) + ']';
      }

      return null;
    }
  ;
    
    $def(self, '$instance_variables', function $$instance_variables() {
      
      return []
    }, 0);
    $defs(self, '$_load', function $$_load($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return $send(self, 'new', $to_a(args));
    }, -1);
    
    $def(self, '$unicode_normalize', function $$unicode_normalize(form) {
      var self = this;

      
      
      if (form == null) form = "nfc";;
      if (!$truthy(["nfc", "nfd", "nfkc", "nfkd"]['$include?'](form))) {
        $Kernel.$raise($$$('ArgumentError'), "Invalid normalization form " + (form))
      };
      return self.normalize(form.$upcase());
    }, -1);
    
    $def(self, '$unicode_normalized?', function $String_unicode_normalized$ques$18(form) {
      var self = this;

      
      
      if (form == null) form = "nfc";;
      return self.$unicode_normalize(form)['$=='](self);
    }, -1);
    
    $def(self, '$unpack', function $$unpack(format) {
      
      return $Kernel.$raise("To use String#unpack, you must first require 'corelib/string/unpack'.")
    }, 1);
    
    $def(self, '$unpack1', function $$unpack1(format) {
      
      return $Kernel.$raise("To use String#unpack1, you must first require 'corelib/string/unpack'.")
    }, 1);
    
    $def(self, '$freeze', function $$freeze() {
      var self = this;

      
      if (typeof self === 'string') return self;
      self.$$frozen = true;
      return self;
    
    }, 0);
    
    $def(self, '$-@', function $String_$minus$$19() {
      var self = this;

      
      if (typeof self === 'string') return self;
      if (self.$$frozen === true) return self;
      if (self.encoding.name == 'UTF-8' && self.internal_encoding.name == 'UTF-8') return self.toString();
      return self.$dup().$freeze();
    
    }, 0);
    
    $def(self, '$frozen?', function $String_frozen$ques$20() {
      var self = this;

      return typeof self === 'string' || self.$$frozen === true;
    }, 0);
    $alias(self, "+@", "dup");
    $alias(self, "===", "==");
    $alias(self, "byteslice", "[]");
    $alias(self, "eql?", "==");
    $alias(self, "equal?", "===");
    $alias(self, "object_id", "__id__");
    $alias(self, "slice", "[]");
    $alias(self, "succ", "next");
    $alias(self, "to_str", "to_s");
    $alias(self, "to_sym", "intern");
    return $Opal.$pristine(self, "initialize");
  })('::', String, $nesting);
  return $const_set($nesting[0], 'Symbol', $$('String'));
};

Opal.modules["corelib/enumerable"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $coerce_to = Opal.coerce_to, $yield1 = Opal.yield1, $yieldX = Opal.yieldX, $module = Opal.module, $send = Opal.send, $to_a = Opal.to_a, $Opal = Opal.Opal, $def = Opal.def, $Kernel = Opal.Kernel, $return_val = Opal.return_val, $rb_gt = Opal.rb_gt, $rb_times = Opal.rb_times, $rb_lt = Opal.rb_lt, $eqeq = Opal.eqeq, $rb_plus = Opal.rb_plus, $rb_minus = Opal.rb_minus, $rb_divide = Opal.rb_divide, $rb_le = Opal.rb_le, $hash2 = Opal.hash2, $lambda = Opal.lambda, $not = Opal.not, $alias = Opal.alias;

  Opal.add_stubs('each,public_send,destructure,to_enum,enumerator_size,new,yield,raise,slice_when,!,enum_for,flatten,map,compact,to_a,warn,proc,==,nil?,respond_to?,coerce_to!,>,*,try_convert,<,+,-,ceil,/,size,select,to_proc,__send__,length,<=,[],push,<<,[]=,===,inspect,<=>,first,reverse,sort,take,sort_by,compare,call,dup,sort!,map!,include?,-@,key?,values,transform_values,group_by,fetch,to_h,coerce_to?,class,zip,detect,find_all,collect_concat,collect,inject,entries');
  return (function($base) {
    var self = $module($base, 'Enumerable');

    
    
    
    function comparableForPattern(value) {
      if (value.length === 0) {
        value = [nil];
      }

      if (value.length > 1) {
        value = [value];
      }

      return value;
    }
  ;
    
    $def(self, '$all?', function $Enumerable_all$ques$1(pattern) {try {

      var block = $Enumerable_all$ques$1.$$p || nil, self = this;

      delete $Enumerable_all$ques$1.$$p;
      
      ;
      ;
      if ($truthy(pattern !== undefined)) {
        $send(self, 'each', [], function $$2($a){var $post_args, value, comparable = nil;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          comparable = comparableForPattern(value);
          if ($truthy($send(pattern, 'public_send', ["==="].concat($to_a(comparable))))) {
            return nil
          } else {
            Opal.ret(false)
          };}, -1)
      } else if ((block !== nil)) {
        $send(self, 'each', [], function $$3($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if ($truthy(Opal.yieldX(block, $to_a(value)))) {
            return nil
          } else {
            Opal.ret(false)
          };}, -1)
      } else {
        $send(self, 'each', [], function $$4($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if ($truthy($Opal.$destructure(value))) {
            return nil
          } else {
            Opal.ret(false)
          };}, -1)
      };
      return true;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, -1);
    
    $def(self, '$any?', function $Enumerable_any$ques$5(pattern) {try {

      var block = $Enumerable_any$ques$5.$$p || nil, self = this;

      delete $Enumerable_any$ques$5.$$p;
      
      ;
      ;
      if ($truthy(pattern !== undefined)) {
        $send(self, 'each', [], function $$6($a){var $post_args, value, comparable = nil;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          comparable = comparableForPattern(value);
          if ($truthy($send(pattern, 'public_send', ["==="].concat($to_a(comparable))))) {
            Opal.ret(true)
          } else {
            return nil
          };}, -1)
      } else if ((block !== nil)) {
        $send(self, 'each', [], function $$7($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if ($truthy(Opal.yieldX(block, $to_a(value)))) {
            Opal.ret(true)
          } else {
            return nil
          };}, -1)
      } else {
        $send(self, 'each', [], function $$8($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if ($truthy($Opal.$destructure(value))) {
            Opal.ret(true)
          } else {
            return nil
          };}, -1)
      };
      return false;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, -1);
    
    $def(self, '$chunk', function $$chunk() {
      var block = $$chunk.$$p || nil, self = this;

      delete $$chunk.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'to_enum', ["chunk"], function $$9(){var self = $$9.$$s == null ? this : $$9.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      return $send($$$('Enumerator'), 'new', [], function $$10(yielder){var self = $$10.$$s == null ? this : $$10.$$s;

        
        
        if (yielder == null) yielder = nil;;
        
        var previous = nil, accumulate = [];

        function releaseAccumulate() {
          if (accumulate.length > 0) {
            yielder.$yield(previous, accumulate)
          }
        }

        self.$each.$$p = function(value) {
          var key = $yield1(block, value);

          if (key === nil) {
            releaseAccumulate();
            accumulate = [];
            previous = nil;
          } else {
            if (previous === nil || previous === key) {
              accumulate.push(value);
            } else {
              releaseAccumulate();
              accumulate = [value];
            }

            previous = key;
          }
        }

        self.$each();

        releaseAccumulate();
      ;}, {$$arity: 1, $$s: self});
    }, 0);
    
    $def(self, '$chunk_while', function $$chunk_while() {
      var block = $$chunk_while.$$p || nil, self = this;

      delete $$chunk_while.$$p;
      
      ;
      if (!(block !== nil)) {
        $Kernel.$raise($$$('ArgumentError'), "no block given")
      };
      return $send(self, 'slice_when', [], function $$11(before, after){
        
        
        if (before == null) before = nil;;
        
        if (after == null) after = nil;;
        return Opal.yieldX(block, [before, after])['$!']();}, 2);
    }, 0);
    
    $def(self, '$collect', function $$collect() {
      var block = $$collect.$$p || nil, self = this;

      delete $$collect.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["collect"], function $$12(){var self = $$12.$$s == null ? this : $$12.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      var result = [];

      self.$each.$$p = function() {
        var value = $yieldX(block, arguments);

        result.push(value);
      };

      self.$each();

      return result;
    ;
    }, 0);
    
    $def(self, '$collect_concat', function $$collect_concat() {
      var block = $$collect_concat.$$p || nil, self = this;

      delete $$collect_concat.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["collect_concat"], function $$13(){var self = $$13.$$s == null ? this : $$13.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      return $send(self, 'map', [], function $$14(item){
        
        
        if (item == null) item = nil;;
        return Opal.yield1(block, item);;}, 1).$flatten(1);
    }, 0);
    
    $def(self, '$compact', function $$compact() {
      var self = this;

      return self.$to_a().$compact()
    }, 0);
    
    $def(self, '$count', function $$count(object) {
      var block = $$count.$$p || nil, self = this, result = nil;

      delete $$count.$$p;
      
      ;
      ;
      result = 0;
      
      if (object != null && block !== nil) {
        self.$warn("warning: given block not used")
      }
    ;
      if ($truthy(object != null)) {
        block = $send($Kernel, 'proc', [], function $$15($a){var $post_args, args;

          
          
          $post_args = Opal.slice.call(arguments);
          
          args = $post_args;;
          return $Opal.$destructure(args)['$=='](object);}, -1)
      } else if ($truthy(block['$nil?']())) {
        block = $send($Kernel, 'proc', [], $return_val(true), 0)
      };
      $send(self, 'each', [], function $$16($a){var $post_args, args;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        if ($truthy($yieldX(block, args))) {
          return result++;
        } else {
          return nil
        };}, -1);
      return result;
    }, -1);
    
    $def(self, '$cycle', function $$cycle(n) {
      var block = $$cycle.$$p || nil, self = this;

      delete $$cycle.$$p;
      
      ;
      
      if (n == null) n = nil;;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["cycle", n], function $$17(){var self = $$17.$$s == null ? this : $$17.$$s;

          if ($truthy(n['$nil?']())) {
            if ($truthy(self['$respond_to?']("size"))) {
              return $$$($$$('Float'), 'INFINITY')
            } else {
              return nil
            }
          } else {
            
            n = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
            if ($truthy($rb_gt(n, 0))) {
              return $rb_times(self.$enumerator_size(), n)
            } else {
              return 0
            };
          }}, {$$arity: 0, $$s: self})
      };
      if (!$truthy(n['$nil?']())) {
        
        n = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
        if ($truthy(n <= 0)) {
          return nil
        };
      };
      
      var all = [], i, length, value;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        all.push(param);
      }

      self.$each();

      if (all.length === 0) {
        return nil;
      }

      if (n === nil) {
        while (true) {
          for (i = 0, length = all.length; i < length; i++) {
            value = $yield1(block, all[i]);
          }
        }
      }
      else {
        while (n > 1) {
          for (i = 0, length = all.length; i < length; i++) {
            value = $yield1(block, all[i]);
          }

          n--;
        }
      }
    ;
    }, -1);
    
    $def(self, '$detect', function $$detect(ifnone) {try {

      var block = $$detect.$$p || nil, self = this;

      delete $$detect.$$p;
      
      ;
      ;
      if (!(block !== nil)) {
        return self.$enum_for("detect", ifnone)
      };
      $send(self, 'each', [], function $$18($a){var $post_args, args, value = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        value = $Opal.$destructure(args);
        if ($truthy(Opal.yield1(block, value))) {
          Opal.ret(value)
        } else {
          return nil
        };}, -1);
      
      if (ifnone !== undefined) {
        if (typeof(ifnone) === 'function') {
          return ifnone();
        } else {
          return ifnone;
        }
      }
    ;
      return nil;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, -1);
    
    $def(self, '$drop', function $$drop(number) {
      var self = this;

      
      number = $coerce_to(number, $$$('Integer'), 'to_int');
      if ($truthy(number < 0)) {
        $Kernel.$raise($$$('ArgumentError'), "attempt to drop negative size")
      };
      
      var result  = [],
          current = 0;

      self.$each.$$p = function() {
        if (number <= current) {
          result.push($Opal.$destructure(arguments));
        }

        current++;
      };

      self.$each()

      return result;
    ;
    }, 1);
    
    $def(self, '$drop_while', function $$drop_while() {
      var block = $$drop_while.$$p || nil, self = this;

      delete $$drop_while.$$p;
      
      ;
      if (!(block !== nil)) {
        return self.$enum_for("drop_while")
      };
      
      var result   = [],
          dropping = true;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments);

        if (dropping) {
          var value = $yield1(block, param);

          if (!$truthy(value)) {
            dropping = false;
            result.push(param);
          }
        }
        else {
          result.push(param);
        }
      };

      self.$each();

      return result;
    ;
    }, 0);
    
    $def(self, '$each_cons', function $$each_cons(n) {
      var block = $$each_cons.$$p || nil, self = this;

      delete $$each_cons.$$p;
      
      ;
      if ($truthy(arguments.length != 1)) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 1)")
      };
      n = $Opal.$try_convert(n, $$$('Integer'), "to_int");
      if ($truthy(n <= 0)) {
        $Kernel.$raise($$$('ArgumentError'), "invalid size")
      };
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_cons", n], function $$19(){var self = $$19.$$s == null ? this : $$19.$$s, enum_size = nil;

          
          enum_size = self.$enumerator_size();
          if ($truthy(enum_size['$nil?']())) {
            return nil
          } else if (($eqeq(enum_size, 0) || ($truthy($rb_lt(enum_size, n))))) {
            return 0
          } else {
            return $rb_plus($rb_minus(enum_size, n), 1)
          };}, {$$arity: 0, $$s: self})
      };
      
      var buffer = [];

      self.$each.$$p = function() {
        var element = $Opal.$destructure(arguments);
        buffer.push(element);
        if (buffer.length > n) {
          buffer.shift();
        }
        if (buffer.length == n) {
          $yield1(block, buffer.slice(0, n));
        }
      }

      self.$each();

      return self;
    ;
    }, 1);
    
    $def(self, '$each_entry', function $$each_entry($a) {
      var block = $$each_entry.$$p || nil, $post_args, data, self = this;

      delete $$each_entry.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      data = $post_args;;
      if (!(block !== nil)) {
        return $send(self, 'to_enum', ["each_entry"].concat($to_a(data)), function $$20(){var self = $$20.$$s == null ? this : $$20.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      self.$each.$$p = function() {
        var item = $Opal.$destructure(arguments);

        $yield1(block, item);
      }

      self.$each.apply(self, data);

      return self;
    ;
    }, -1);
    
    $def(self, '$each_slice', function $$each_slice(n) {
      var block = $$each_slice.$$p || nil, self = this;

      delete $$each_slice.$$p;
      
      ;
      n = $coerce_to(n, $$$('Integer'), 'to_int');
      if ($truthy(n <= 0)) {
        $Kernel.$raise($$$('ArgumentError'), "invalid slice size")
      };
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_slice", n], function $$21(){var self = $$21.$$s == null ? this : $$21.$$s;

          if ($truthy(self['$respond_to?']("size"))) {
            return $rb_divide(self.$size(), n).$ceil()
          } else {
            return nil
          }}, {$$arity: 0, $$s: self})
      };
      
      var slice = []

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments);

        slice.push(param);

        if (slice.length === n) {
          $yield1(block, slice);
          slice = [];
        }
      };

      self.$each();

      // our "last" group, if smaller than n then won't have been yielded
      if (slice.length > 0) {
        $yield1(block, slice);
      }
    ;
      return self;
    }, 1);
    
    $def(self, '$each_with_index', function $$each_with_index($a) {
      var block = $$each_with_index.$$p || nil, $post_args, args, self = this;

      delete $$each_with_index.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_with_index"].concat($to_a(args)), function $$22(){var self = $$22.$$s == null ? this : $$22.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      var index = 0;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments);

        block(param, index);

        index++;
      };

      self.$each.apply(self, args);
    ;
      return self;
    }, -1);
    
    $def(self, '$each_with_object', function $$each_with_object(object) {
      var block = $$each_with_object.$$p || nil, self = this;

      delete $$each_with_object.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_with_object", object], function $$23(){var self = $$23.$$s == null ? this : $$23.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments);

        block(param, object);
      };

      self.$each();
    ;
      return object;
    }, 1);
    
    $def(self, '$entries', function $$entries($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var result = [];

      self.$each.$$p = function() {
        result.push($Opal.$destructure(arguments));
      };

      self.$each.apply(self, args);

      return result;
    ;
    }, -1);
    
    $def(self, '$filter_map', function $$filter_map() {
      var block = $$filter_map.$$p || nil, self = this;

      delete $$filter_map.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["filter_map"], function $$24(){var self = $$24.$$s == null ? this : $$24.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      return $send($send(self, 'map', [], block.$to_proc()), 'select', [], "itself".$to_proc());
    }, 0);
    
    $def(self, '$find_all', function $$find_all() {
      var block = $$find_all.$$p || nil, self = this;

      delete $$find_all.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["find_all"], function $$25(){var self = $$25.$$s == null ? this : $$25.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        if ($truthy(value)) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    ;
    }, 0);
    
    $def(self, '$find_index', function $$find_index(object) {try {

      var block = $$find_index.$$p || nil, self = this, index = nil;

      delete $$find_index.$$p;
      
      ;
      ;
      if ($truthy(object === undefined && block === nil)) {
        return self.$enum_for("find_index")
      };
      
      if (object != null && block !== nil) {
        self.$warn("warning: given block not used")
      }
    ;
      index = 0;
      if ($truthy(object != null)) {
        $send(self, 'each', [], function $$26($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if ($eqeq($Opal.$destructure(value), object)) {
            Opal.ret(index)
          };
          return index += 1;;}, -1)
      } else {
        $send(self, 'each', [], function $$27($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if ($truthy(Opal.yieldX(block, $to_a(value)))) {
            Opal.ret(index)
          };
          return index += 1;;}, -1)
      };
      return nil;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, -1);
    
    $def(self, '$first', function $$first(number) {try {

      var self = this, result = nil, current = nil;

      
      ;
      if ($truthy(number === undefined)) {
        return $send(self, 'each', [], function $$28(value){
          
          
          if (value == null) value = nil;;
          Opal.ret(value);}, 1)
      } else {
        
        result = [];
        number = $coerce_to(number, $$$('Integer'), 'to_int');
        if ($truthy(number < 0)) {
          $Kernel.$raise($$$('ArgumentError'), "attempt to take negative size")
        };
        if ($truthy(number == 0)) {
          return []
        };
        current = 0;
        $send(self, 'each', [], function $$29($a){var $post_args, args;

          
          
          $post_args = Opal.slice.call(arguments);
          
          args = $post_args;;
          result.push($Opal.$destructure(args));
          if ($truthy(number <= ++current)) {
            Opal.ret(result)
          } else {
            return nil
          };}, -1);
        return result;
      };
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, -1);
    
    $def(self, '$grep', function $$grep(pattern) {
      var block = $$grep.$$p || nil, self = this, result = nil;

      delete $$grep.$$p;
      
      ;
      result = [];
      $send(self, 'each', [], function $$30($a){var $post_args, value, cmp = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        value = $post_args;;
        cmp = comparableForPattern(value);
        if (!$truthy($send(pattern, '__send__', ["==="].concat($to_a(cmp))))) {
          return nil;
        };
        if ((block !== nil)) {
          
          if ($truthy($rb_gt(value.$length(), 1))) {
            value = [value]
          };
          value = Opal.yieldX(block, $to_a(value));
        } else if ($truthy($rb_le(value.$length(), 1))) {
          value = value['$[]'](0)
        };
        return result.$push(value);}, -1);
      return result;
    }, 1);
    
    $def(self, '$grep_v', function $$grep_v(pattern) {
      var block = $$grep_v.$$p || nil, self = this, result = nil;

      delete $$grep_v.$$p;
      
      ;
      result = [];
      $send(self, 'each', [], function $$31($a){var $post_args, value, cmp = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        value = $post_args;;
        cmp = comparableForPattern(value);
        if ($truthy($send(pattern, '__send__', ["==="].concat($to_a(cmp))))) {
          return nil;
        };
        if ((block !== nil)) {
          
          if ($truthy($rb_gt(value.$length(), 1))) {
            value = [value]
          };
          value = Opal.yieldX(block, $to_a(value));
        } else if ($truthy($rb_le(value.$length(), 1))) {
          value = value['$[]'](0)
        };
        return result.$push(value);}, -1);
      return result;
    }, 1);
    
    $def(self, '$group_by', function $$group_by() {
      var block = $$group_by.$$p || nil, $a, self = this, hash = nil, $ret_or_1 = nil;

      delete $$group_by.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["group_by"], function $$32(){var self = $$32.$$s == null ? this : $$32.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      hash = $hash2([], {});
      
      var result;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        ($truthy(($ret_or_1 = hash['$[]'](value))) ? ($ret_or_1) : (($a = [value, []], $send(hash, '[]=', $a), $a[$a.length - 1])))['$<<'](param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    ;
      return hash;
    }, 0);
    
    $def(self, '$include?', function $Enumerable_include$ques$33(obj) {try {

      var self = this;

      
      $send(self, 'each', [], function $$34($a){var $post_args, args;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        if ($eqeq($Opal.$destructure(args), obj)) {
          Opal.ret(true)
        } else {
          return nil
        };}, -1);
      return false;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, 1);
    
    $def(self, '$inject', function $$inject(object, sym) {
      var block = $$inject.$$p || nil, self = this;

      delete $$inject.$$p;
      
      ;
      ;
      ;
      
      var result = object;

      if (block !== nil && sym === undefined) {
        self.$each.$$p = function() {
          var value = $Opal.$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          value = $yieldX(block, [result, value]);

          result = value;
        };
      }
      else {
        if (sym === undefined) {
          if (!$$$('Symbol')['$==='](object)) {
            $Kernel.$raise($$$('TypeError'), "" + (object.$inspect()) + " is not a Symbol");
          }

          sym    = object;
          result = undefined;
        }

        self.$each.$$p = function() {
          var value = $Opal.$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          result = (result).$__send__(sym, value);
        };
      }

      self.$each();

      return result == undefined ? nil : result;
    ;
    }, -1);
    
    $def(self, '$lazy', function $$lazy() {
      var self = this;

      return $send($$$($$$('Enumerator'), 'Lazy'), 'new', [self, self.$enumerator_size()], function $$35(enum$, $a){var $post_args, args;

        
        
        if (enum$ == null) enum$ = nil;;
        
        $post_args = Opal.slice.call(arguments, 1);
        
        args = $post_args;;
        return $send(enum$, 'yield', $to_a(args));}, -2)
    }, 0);
    
    $def(self, '$enumerator_size', function $$enumerator_size() {
      var self = this;

      if ($truthy(self['$respond_to?']("size"))) {
        return self.$size()
      } else {
        return nil
      }
    }, 0);
    
    $def(self, '$max', function $$max(n) {
      var block = $$max.$$p || nil, self = this;

      delete $$max.$$p;
      
      ;
      ;
      
      if (n === undefined || n === nil) {
        var result, value;

        self.$each.$$p = function() {
          var item = $Opal.$destructure(arguments);

          if (result === undefined) {
            result = item;
            return;
          }

          if (block !== nil) {
            value = $yieldX(block, [item, result]);
          } else {
            value = (item)['$<=>'](result);
          }

          if (value === nil) {
            $Kernel.$raise($$$('ArgumentError'), "comparison failed");
          }

          if (value > 0) {
            result = item;
          }
        }

        self.$each();

        if (result === undefined) {
          return nil;
        } else {
          return result;
        }
      }

      n = $coerce_to(n, $$$('Integer'), 'to_int');
    ;
      return $send(self, 'sort', [], block.$to_proc()).$reverse().$first(n);
    }, -1);
    
    $def(self, '$max_by', function $$max_by(n) {
      var block = $$max_by.$$p || nil, self = this;

      delete $$max_by.$$p;
      
      ;
      
      if (n == null) n = nil;;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["max_by", n], function $$36(){var self = $$36.$$s == null ? this : $$36.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      if (!$truthy(n['$nil?']())) {
        return $send(self, 'sort_by', [], block.$to_proc()).$reverse().$take(n)
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if ((value)['$<=>'](by) > 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    ;
    }, -1);
    
    $def(self, '$min', function $$min(n) {
      var block = $$min.$$p || nil, self = this;

      delete $$min.$$p;
      
      ;
      
      if (n == null) n = nil;;
      if (!$truthy(n['$nil?']())) {
        if ((block !== nil)) {
          return $send(self, 'sort', [], function $$37(a, b){
            
            
            if (a == null) a = nil;;
            
            if (b == null) b = nil;;
            return Opal.yieldX(block, [a, b]);;}, 2).$take(n)
        } else {
          return self.$sort().$take(n)
        }
      };
      
      var result;

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $Opal.$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === nil) {
            $Kernel.$raise($$$('ArgumentError'), "comparison failed");
          }

          if (value < 0) {
            result = param;
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $Opal.$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ($Opal.$compare(param, result) < 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    ;
    }, -1);
    
    $def(self, '$min_by', function $$min_by(n) {
      var block = $$min_by.$$p || nil, self = this;

      delete $$min_by.$$p;
      
      ;
      
      if (n == null) n = nil;;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["min_by", n], function $$38(){var self = $$38.$$s == null ? this : $$38.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      if (!$truthy(n['$nil?']())) {
        return $send(self, 'sort_by', [], block.$to_proc()).$take(n)
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if ((value)['$<=>'](by) < 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    ;
    }, -1);
    
    $def(self, '$minmax', function $$minmax() {
      var block = $$minmax.$$p || nil, self = this, $ret_or_1 = nil;

      delete $$minmax.$$p;
      
      ;
      block = ($truthy(($ret_or_1 = block)) ? ($ret_or_1) : ($send($Kernel, 'proc', [], function $$39(a, b){
        
        
        if (a == null) a = nil;;
        
        if (b == null) b = nil;;
        return a['$<=>'](b);}, 2)));
      
      var min = nil, max = nil, first_time = true;

      self.$each.$$p = function() {
        var element = $Opal.$destructure(arguments);
        if (first_time) {
          min = max = element;
          first_time = false;
        } else {
          var min_cmp = block.$call(min, element);

          if (min_cmp === nil) {
            $Kernel.$raise($$$('ArgumentError'), "comparison failed")
          } else if (min_cmp > 0) {
            min = element;
          }

          var max_cmp = block.$call(max, element);

          if (max_cmp === nil) {
            $Kernel.$raise($$$('ArgumentError'), "comparison failed")
          } else if (max_cmp < 0) {
            max = element;
          }
        }
      }

      self.$each();

      return [min, max];
    ;
    }, 0);
    
    $def(self, '$minmax_by', function $$minmax_by() {
      var block = $$minmax_by.$$p || nil, self = this;

      delete $$minmax_by.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["minmax_by"], function $$40(){var self = $$40.$$s == null ? this : $$40.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      var min_result = nil,
          max_result = nil,
          min_by,
          max_by;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        if ((min_by === undefined) || (value)['$<=>'](min_by) < 0) {
          min_result = param;
          min_by     = value;
        }

        if ((max_by === undefined) || (value)['$<=>'](max_by) > 0) {
          max_result = param;
          max_by     = value;
        }
      };

      self.$each();

      return [min_result, max_result];
    ;
    }, 0);
    
    $def(self, '$none?', function $Enumerable_none$ques$41(pattern) {try {

      var block = $Enumerable_none$ques$41.$$p || nil, self = this;

      delete $Enumerable_none$ques$41.$$p;
      
      ;
      ;
      if ($truthy(pattern !== undefined)) {
        $send(self, 'each', [], function $$42($a){var $post_args, value, comparable = nil;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          comparable = comparableForPattern(value);
          if ($truthy($send(pattern, 'public_send', ["==="].concat($to_a(comparable))))) {
            Opal.ret(false)
          } else {
            return nil
          };}, -1)
      } else if ((block !== nil)) {
        $send(self, 'each', [], function $$43($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if ($truthy(Opal.yieldX(block, $to_a(value)))) {
            Opal.ret(false)
          } else {
            return nil
          };}, -1)
      } else {
        $send(self, 'each', [], function $$44($a){var $post_args, value, item = nil;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          item = $Opal.$destructure(value);
          if ($truthy(item)) {
            Opal.ret(false)
          } else {
            return nil
          };}, -1)
      };
      return true;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, -1);
    
    $def(self, '$one?', function $Enumerable_one$ques$45(pattern) {try {

      var block = $Enumerable_one$ques$45.$$p || nil, self = this, count = nil;

      delete $Enumerable_one$ques$45.$$p;
      
      ;
      ;
      count = 0;
      if ($truthy(pattern !== undefined)) {
        $send(self, 'each', [], function $$46($a){var $post_args, value, comparable = nil;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          comparable = comparableForPattern(value);
          if ($truthy($send(pattern, 'public_send', ["==="].concat($to_a(comparable))))) {
            
            count = $rb_plus(count, 1);
            if ($truthy($rb_gt(count, 1))) {
              Opal.ret(false)
            } else {
              return nil
            };
          } else {
            return nil
          };}, -1)
      } else if ((block !== nil)) {
        $send(self, 'each', [], function $$47($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if (!$truthy(Opal.yieldX(block, $to_a(value)))) {
            return nil;
          };
          count = $rb_plus(count, 1);
          if ($truthy($rb_gt(count, 1))) {
            Opal.ret(false)
          } else {
            return nil
          };}, -1)
      } else {
        $send(self, 'each', [], function $$48($a){var $post_args, value;

          
          
          $post_args = Opal.slice.call(arguments);
          
          value = $post_args;;
          if (!$truthy($Opal.$destructure(value))) {
            return nil;
          };
          count = $rb_plus(count, 1);
          if ($truthy($rb_gt(count, 1))) {
            Opal.ret(false)
          } else {
            return nil
          };}, -1)
      };
      return count['$=='](1);
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, -1);
    
    $def(self, '$partition', function $$partition() {
      var block = $$partition.$$p || nil, self = this;

      delete $$partition.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["partition"], function $$49(){var self = $$49.$$s == null ? this : $$49.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      var truthy = [], falsy = [], result;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        if ($truthy(value)) {
          truthy.push(param);
        }
        else {
          falsy.push(param);
        }
      };

      self.$each();

      return [truthy, falsy];
    ;
    }, 0);
    
    $def(self, '$reject', function $$reject() {
      var block = $$reject.$$p || nil, self = this;

      delete $$reject.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["reject"], function $$50(){var self = $$50.$$s == null ? this : $$50.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = $yield1(block, param);

        if (!$truthy(value)) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    ;
    }, 0);
    
    $def(self, '$reverse_each', function $$reverse_each() {
      var block = $$reverse_each.$$p || nil, self = this;

      delete $$reverse_each.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["reverse_each"], function $$51(){var self = $$51.$$s == null ? this : $$51.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      
      var result = [];

      self.$each.$$p = function() {
        result.push(arguments);
      };

      self.$each();

      for (var i = result.length - 1; i >= 0; i--) {
        $yieldX(block, result[i]);
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$slice_before', function $$slice_before(pattern) {
      var block = $$slice_before.$$p || nil, self = this;

      delete $$slice_before.$$p;
      
      ;
      ;
      if ($truthy(pattern === undefined && block === nil)) {
        $Kernel.$raise($$$('ArgumentError'), "both pattern and block are given")
      };
      if ($truthy(pattern !== undefined && block !== nil || arguments.length > 1)) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " expected 1)")
      };
      return $send($$$('Enumerator'), 'new', [], function $$52(e){var self = $$52.$$s == null ? this : $$52.$$s;

        
        
        if (e == null) e = nil;;
        
        var slice = [];

        if (block !== nil) {
          if (pattern === undefined) {
            self.$each.$$p = function() {
              var param = $Opal.$destructure(arguments),
                  value = $yield1(block, param);

              if ($truthy(value) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
          else {
            self.$each.$$p = function() {
              var param = $Opal.$destructure(arguments),
                  value = block(param, pattern.$dup());

              if ($truthy(value) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
        }
        else {
          self.$each.$$p = function() {
            var param = $Opal.$destructure(arguments),
                value = pattern['$==='](param);

            if ($truthy(value) && slice.length > 0) {
              e['$<<'](slice);
              slice = [];
            }

            slice.push(param);
          };
        }

        self.$each();

        if (slice.length > 0) {
          e['$<<'](slice);
        }
      ;}, {$$arity: 1, $$s: self});
    }, -1);
    
    $def(self, '$slice_after', function $$slice_after(pattern) {
      var block = $$slice_after.$$p || nil, self = this;

      delete $$slice_after.$$p;
      
      ;
      ;
      if ($truthy(pattern === undefined && block === nil)) {
        $Kernel.$raise($$$('ArgumentError'), "both pattern and block are given")
      };
      if ($truthy(pattern !== undefined && block !== nil || arguments.length > 1)) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " expected 1)")
      };
      if ($truthy(pattern !== undefined)) {
        block = $send($Kernel, 'proc', [], function $$53(e){
          
          
          if (e == null) e = nil;;
          return pattern['$==='](e);}, 1)
      };
      return $send($$$('Enumerator'), 'new', [], function $$54(yielder){var self = $$54.$$s == null ? this : $$54.$$s;

        
        
        if (yielder == null) yielder = nil;;
        
        var accumulate;

        self.$each.$$p = function() {
          var element = $Opal.$destructure(arguments),
              end_chunk = $yield1(block, element);

          if (accumulate == null) {
            accumulate = [];
          }

          if ($truthy(end_chunk)) {
            accumulate.push(element);
            yielder.$yield(accumulate);
            accumulate = null;
          } else {
            accumulate.push(element)
          }
        }

        self.$each();

        if (accumulate != null) {
          yielder.$yield(accumulate);
        }
      ;}, {$$arity: 1, $$s: self});
    }, -1);
    
    $def(self, '$slice_when', function $$slice_when() {
      var block = $$slice_when.$$p || nil, self = this;

      delete $$slice_when.$$p;
      
      ;
      if (!(block !== nil)) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (0 for 1)")
      };
      return $send($$$('Enumerator'), 'new', [], function $$55(yielder){var self = $$55.$$s == null ? this : $$55.$$s;

        
        
        if (yielder == null) yielder = nil;;
        
        var slice = nil, last_after = nil;

        self.$each_cons.$$p = function() {
          var params = $Opal.$destructure(arguments),
              before = params[0],
              after = params[1],
              match = $yieldX(block, [before, after]);

          last_after = after;

          if (slice === nil) {
            slice = [];
          }

          if ($truthy(match)) {
            slice.push(before);
            yielder.$yield(slice);
            slice = [];
          } else {
            slice.push(before);
          }
        }

        self.$each_cons(2);

        if (slice !== nil) {
          slice.push(last_after);
          yielder.$yield(slice);
        }
      ;}, {$$arity: 1, $$s: self});
    }, 0);
    
    $def(self, '$sort', function $$sort() {
      var block = $$sort.$$p || nil, self = this, ary = nil;

      delete $$sort.$$p;
      
      ;
      ary = self.$to_a();
      if (!(block !== nil)) {
        block = $lambda(function $$56(a, b){
          
          
          if (a == null) a = nil;;
          
          if (b == null) b = nil;;
          return a['$<=>'](b);}, 2)
      };
      return $send(ary, 'sort', [], block.$to_proc());
    }, 0);
    
    $def(self, '$sort_by', function $$sort_by() {
      var block = $$sort_by.$$p || nil, self = this, dup = nil;

      delete $$sort_by.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["sort_by"], function $$57(){var self = $$57.$$s == null ? this : $$57.$$s;

          return self.$enumerator_size()}, {$$arity: 0, $$s: self})
      };
      dup = $send(self, 'map', [], function $$58(){var arg = nil;

        
        arg = $Opal.$destructure(arguments);
        return [Opal.yield1(block, arg), arg];}, 0);
      $send(dup, 'sort!', [], function $$59(a, b){
        
        
        if (a == null) a = nil;;
        
        if (b == null) b = nil;;
        return (a[0])['$<=>'](b[0]);}, 2);
      return $send(dup, 'map!', [], function $$60(i){
        
        
        if (i == null) i = nil;;
        return i[1];;}, 1);
    }, 0);
    
    $def(self, '$sum', function $$sum(initial) {
      var $yield = $$sum.$$p || nil, self = this, result = nil, compensation = nil;

      delete $$sum.$$p;
      
      
      if (initial == null) initial = 0;;
      result = initial;
      compensation = 0;
      $send(self, 'each', [], function $$61($a){var $post_args, args, item = nil, y = nil, t = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        item = (($yield !== nil) ? (Opal.yieldX($yield, $to_a(args))) : ($Opal.$destructure(args)));
        if (($not([$$$($$$('Float'), 'INFINITY'), $$$($$$('Float'), 'INFINITY')['$-@']()]['$include?'](item)) && ($truthy(item['$respond_to?']("-"))))) {
          
          y = $rb_minus(item, compensation);
          t = $rb_plus(result, y);
          compensation = $rb_minus($rb_minus(t, result), y);
          return (result = t);
        } else {
          return (result = $rb_plus(result, item))
        };}, -1);
      return result;
    }, -1);
    
    $def(self, '$take', function $$take(num) {
      var self = this;

      return self.$first(num)
    }, 1);
    
    $def(self, '$take_while', function $$take_while() {try {

      var block = $$take_while.$$p || nil, self = this, result = nil;

      delete $$take_while.$$p;
      
      ;
      if (!$truthy(block)) {
        return self.$enum_for("take_while")
      };
      result = [];
      return $send(self, 'each', [], function $$62($a){var $post_args, args, value = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        value = $Opal.$destructure(args);
        if (!$truthy(Opal.yield1(block, value))) {
          Opal.ret(result)
        };
        return result.push(value);;}, -1);
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, 0);
    
    $def(self, '$uniq', function $$uniq() {
      var block = $$uniq.$$p || nil, self = this, hash = nil;

      delete $$uniq.$$p;
      
      ;
      hash = $hash2([], {});
      $send(self, 'each', [], function $$63($a){var $post_args, args, $b, value = nil, produced = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        value = $Opal.$destructure(args);
        produced = ((block !== nil) ? (Opal.yield1(block, value)) : (value));
        if ($truthy(hash['$key?'](produced))) {
          return nil
        } else {
          return ($b = [produced, value], $send(hash, '[]=', $b), $b[$b.length - 1])
        };}, -1);
      return hash.$values();
    }, 0);
    
    $def(self, '$tally', function $$tally(hash) {
      var self = this, out = nil;

      
      ;
      out = $send($send(self, 'group_by', [], "itself".$to_proc()), 'transform_values', [], "count".$to_proc());
      if ($truthy(hash)) {
        
        $send(out, 'each', [], function $$64(k, v){var $a;

          
          
          if (k == null) k = nil;;
          
          if (v == null) v = nil;;
          return ($a = [k, $rb_plus(hash.$fetch(k, 0), v)], $send(hash, '[]=', $a), $a[$a.length - 1]);}, 2);
        return hash;
      } else {
        return out
      };
    }, -1);
    
    $def(self, '$to_h', function $$to_h($a) {
      var block = $$to_h.$$p || nil, $post_args, args, self = this;

      delete $$to_h.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if ((block !== nil)) {
        return $send($send(self, 'map', [], block.$to_proc()), 'to_h', $to_a(args))
      };
      
      var hash = $hash2([], {});

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments);
        var ary = $Opal['$coerce_to?'](param, $$$('Array'), "to_ary"), key, val;
        if (!ary.$$is_array) {
          $Kernel.$raise($$$('TypeError'), "wrong element type " + ((ary).$class()) + " (expected array)")
        }
        if (ary.length !== 2) {
          $Kernel.$raise($$$('ArgumentError'), "wrong array length (expected 2, was " + ((ary).$length()) + ")")
        }
        key = ary[0];
        val = ary[1];

        Opal.hash_put(hash, key, val);
      };

      self.$each.apply(self, args);

      return hash;
    ;
    }, -1);
    
    $def(self, '$zip', function $$zip($a) {
      var block = $$zip.$$p || nil, $post_args, others, self = this;

      delete $$zip.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      others = $post_args;;
      return $send(self.$to_a(), 'zip', $to_a(others));
    }, -1);
    $alias(self, "find", "detect");
    $alias(self, "filter", "find_all");
    $alias(self, "flat_map", "collect_concat");
    $alias(self, "map", "collect");
    $alias(self, "member?", "include?");
    $alias(self, "reduce", "inject");
    $alias(self, "select", "find_all");
    return $alias(self, "to_a", "entries");
  })('::')
};

Opal.modules["corelib/enumerator/arithmetic_sequence"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $truthy = Opal.truthy, $to_a = Opal.to_a, $eqeq = Opal.eqeq, $Kernel = Opal.Kernel, $def = Opal.def, $rb_gt = Opal.rb_gt, $rb_lt = Opal.rb_lt, $rb_le = Opal.rb_le, $rb_ge = Opal.rb_ge, $rb_plus = Opal.rb_plus, $rb_minus = Opal.rb_minus, $eqeqeq = Opal.eqeqeq, $not = Opal.not, $rb_times = Opal.rb_times, $rb_divide = Opal.rb_divide, $alias = Opal.alias;

  Opal.add_stubs('is_a?,==,raise,respond_to?,class,attr_reader,begin,end,exclude_end?,>,step,<,<=,>=,-@,_lesser_than_end?,<<,+,-,===,%,_greater_than_begin?,reverse,!,include?,*,to_i,abs,/,hash,inspect');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Enumerator');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $super, $parent_nesting) {
      var self = $klass($base, $super, 'ArithmeticSequence');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

      $proto.step_arg2 = $proto.receiver_num = $proto.step_arg1 = $proto.step = $proto.range = $proto.topfx = $proto.bypfx = $proto.creation_method = $proto.skipped_arg = nil;
      
      Opal.prop(self.$$prototype, '$$is_arithmetic_seq', true);
      var inf = Infinity;
      
      $def(self, '$initialize', function $$initialize(range, step, creation_method) {
        var $a, self = this, $ret_or_1 = nil;

        
        ;
        
        if (creation_method == null) creation_method = "step";;
        self.creation_method = creation_method;
        if ($truthy(range['$is_a?']($$$('Array')))) {
          
          $a = [].concat($to_a(range)), (self.step_arg1 = ($a[0] == null ? nil : $a[0])), (self.step_arg2 = ($a[1] == null ? nil : $a[1])), (self.topfx = ($a[2] == null ? nil : $a[2])), (self.bypfx = ($a[3] == null ? nil : $a[3])), $a;
          self.receiver_num = step;
          self.step = 1;
          self.range = ($truthy(self.step_arg2) ? (((self.step = self.step_arg2), Opal.Range.$new(self.receiver_num, self.step_arg1, false))) : ($truthy(self.step_arg1) ? (Opal.Range.$new(self.receiver_num, self.step_arg1, false)) : (Opal.Range.$new(self.receiver_num, nil, false))));
        } else {
          
          if (!$truthy(step)) {
            self.skipped_arg = true
          };
          $a = [range, ($truthy(($ret_or_1 = step)) ? ($ret_or_1) : (1))], (self.range = $a[0]), (self.step = $a[1]), $a;
        };
        self.object = self;
        if ($eqeq(self.step, 0)) {
          $Kernel.$raise($$('ArgumentError'), "step can't be 0")
        };
        if ($truthy(self.step['$respond_to?']("to_int"))) {
          return nil
        } else {
          return $Kernel.$raise($$('ArgumentError'), "" + ("no implicit conversion of " + (self.step.$class()) + " ") + "into Integer")
        };
      }, -2);
      self.$attr_reader("step");
      
      $def(self, '$begin', function $$begin() {
        var self = this;

        return self.range.$begin()
      }, 0);
      
      $def(self, '$end', function $$end() {
        var self = this;

        return self.range.$end()
      }, 0);
      
      $def(self, '$exclude_end?', function $ArithmeticSequence_exclude_end$ques$1() {
        var self = this;

        return self.range['$exclude_end?']()
      }, 0);
      
      $def(self, '$_lesser_than_end?', function $ArithmeticSequence__lesser_than_end$ques$2(val) {
        var self = this, end_ = nil, $ret_or_1 = nil;

        
        end_ = ($truthy(($ret_or_1 = self.$end())) ? ($ret_or_1) : (inf));
        if ($truthy($rb_gt(self.$step(), 0))) {
          if ($truthy(self['$exclude_end?']())) {
            return $rb_lt(val, end_)
          } else {
            return $rb_le(val, end_)
          }
        } else if ($truthy(self['$exclude_end?']())) {
          return $rb_gt(val, end_)
        } else {
          return $rb_ge(val, end_)
        };
      }, 1);
      
      $def(self, '$_greater_than_begin?', function $ArithmeticSequence__greater_than_begin$ques$3(val) {
        var self = this, begin_ = nil, $ret_or_1 = nil;

        
        begin_ = ($truthy(($ret_or_1 = self.$begin())) ? ($ret_or_1) : ((inf)['$-@']()));
        if ($truthy($rb_gt(self.$step(), 0))) {
          return $rb_gt(val, begin_)
        } else {
          return $rb_lt(val, begin_)
        };
      }, 1);
      
      $def(self, '$first', function $$first(count) {
        var $a, self = this, iter = nil, $ret_or_1 = nil, out = nil;

        
        ;
        iter = ($truthy(($ret_or_1 = self.$begin())) ? ($ret_or_1) : ((inf)['$-@']()));
        if (!$truthy(count)) {
          return ($truthy(self['$_lesser_than_end?'](iter)) ? (iter) : (nil))
        };
        out = [];
        while ($truthy(($truthy(($ret_or_1 = self['$_lesser_than_end?'](iter))) ? ($rb_gt(count, 0)) : ($ret_or_1)))) {
          
          out['$<<'](iter);
          iter = $rb_plus(iter, self.$step());
          count = $rb_minus(count, 1);
        };
        return out;
      }, -1);
      
      $def(self, '$each', function $$each() {
        var block = $$each.$$p || nil, $a, self = this, $ret_or_1 = nil, iter = nil;

        delete $$each.$$p;
        
        ;
        if (!(block !== nil)) {
          return self
        };
        if ($eqeqeq(nil, ($ret_or_1 = self.$begin()))) {
          $Kernel.$raise($$('TypeError'), "nil can't be coerced into Integer")
        } else {
          nil
        };
        iter = ($truthy(($ret_or_1 = self.$begin())) ? ($ret_or_1) : ((inf)['$-@']()));
        while ($truthy(self['$_lesser_than_end?'](iter))) {
          
          Opal.yield1(block, iter);
          iter = $rb_plus(iter, self.$step());
        };
        return self;
      }, 0);
      
      $def(self, '$last', function $$last(count) {
        var $a, self = this, $ret_or_1 = nil, iter = nil, out = nil;

        
        ;
        if (($eqeqeq(inf, ($ret_or_1 = self.$end())) || ($eqeqeq((inf)['$-@'](), $ret_or_1)))) {
          $Kernel.$raise($$$('FloatDomainError'), self.$end())
        } else if ($eqeqeq(nil, $ret_or_1)) {
          $Kernel.$raise($$$('RangeError'), "cannot get the last element of endless arithmetic sequence")
        } else {
          nil
        };
        iter = $rb_minus(self.$end(), $rb_minus(self.$end(), self.$begin())['$%'](self.$step()));
        if (!$truthy(self['$_lesser_than_end?'](iter))) {
          iter = $rb_minus(iter, self.$step())
        };
        if (!$truthy(count)) {
          return ($truthy(self['$_greater_than_begin?'](iter)) ? (iter) : (nil))
        };
        out = [];
        while ($truthy(($truthy(($ret_or_1 = self['$_greater_than_begin?'](iter))) ? ($rb_gt(count, 0)) : ($ret_or_1)))) {
          
          out['$<<'](iter);
          iter = $rb_minus(iter, self.$step());
          count = $rb_minus(count, 1);
        };
        return out.$reverse();
      }, -1);
      
      $def(self, '$size', function $$size() {
        var self = this, step_sign = nil, iter = nil;

        
        step_sign = ($truthy($rb_gt(self.$step(), 0)) ? (1) : (-1));
        if ($not(self['$_lesser_than_end?'](self.$begin()))) {
          return 0
        } else if ($truthy([(inf)['$-@'](), inf]['$include?'](self.$step()))) {
          return 1
        } else if (($truthy([$rb_times((inf)['$-@'](), step_sign), nil]['$include?'](self.$begin())) || ($truthy([$rb_times(inf, step_sign), nil]['$include?'](self.$end()))))) {
          return inf;
        } else {
          
          iter = $rb_minus(self.$end(), $rb_minus(self.$end(), self.$begin())['$%'](self.$step()));
          if (!$truthy(self['$_lesser_than_end?'](iter))) {
            iter = $rb_minus(iter, self.$step())
          };
          return $rb_plus($rb_divide($rb_minus(iter, self.$begin()), self.$step()).$abs().$to_i(), 1);
        };
      }, 0);
      
      $def(self, '$==', function $ArithmeticSequence_$eq_eq$4(other) {
        var self = this, $ret_or_1 = nil, $ret_or_2 = nil, $ret_or_3 = nil, $ret_or_4 = nil;

        if ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = ($truthy(($ret_or_3 = ($truthy(($ret_or_4 = self.$class()['$=='](other.$class()))) ? (self.$begin()['$=='](other.$begin())) : ($ret_or_4)))) ? (self.$end()['$=='](other.$end())) : ($ret_or_3)))) ? (self.$step()['$=='](other.$step())) : ($ret_or_2))))) {
          return self['$exclude_end?']()['$=='](other['$exclude_end?']())
        } else {
          return $ret_or_1
        }
      }, 1);
      
      $def(self, '$hash', function $$hash() {
        var self = this;

        return [self.$begin(), self.$end(), self.$step(), self['$exclude_end?']()].$hash()
      }, 0);
      
      $def(self, '$inspect', function $$inspect() {
        var self = this, args = nil;

        if ($truthy(self.receiver_num)) {
          
          args = ($truthy(self.step_arg2) ? ("(" + (self.topfx) + (self.step_arg1.$inspect()) + ", " + (self.bypfx) + (self.step_arg2.$inspect()) + ")") : ($truthy(self.step_arg1) ? ("(" + (self.topfx) + (self.step_arg1.$inspect()) + ")") : nil));
          return "(" + (self.receiver_num.$inspect()) + "." + (self.creation_method) + (args) + ")";
        } else {
          
          args = ($truthy(self.skipped_arg) ? (nil) : ("(" + (self.step) + ")"));
          return "((" + (self.range.$inspect()) + ")." + (self.creation_method) + (args) + ")";
        }
      }, 0);
      $alias(self, "===", "==");
      return $alias(self, "eql?", "==");
    })(self, self, $nesting)
  })('::', null, $nesting)
};

Opal.modules["corelib/enumerator/chain"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $def = Opal.def, $send = Opal.send, $to_a = Opal.to_a, $truthy = Opal.truthy, $rb_plus = Opal.rb_plus;

  Opal.add_stubs('to_enum,size,each,<<,to_proc,include?,+,reverse_each,respond_to?,rewind,inspect');
  return (function($base, $super) {
    var self = $klass($base, $super, 'Enumerator');

    
    return (function($base, $super) {
      var self = $klass($base, $super, 'Chain');

      var $proto = self.$$prototype;

      $proto.enums = $proto.iterated = nil;
      
      
      $def(self, '$initialize', function $$initialize($a) {
        var $post_args, enums, self = this;

        
        
        $post_args = Opal.slice.call(arguments);
        
        enums = $post_args;;
        self.enums = enums;
        self.iterated = [];
        return (self.object = self);
      }, -1);
      
      $def(self, '$each', function $$each($a) {
        var block = $$each.$$p || nil, $post_args, args, self = this;

        delete $$each.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        if (!(block !== nil)) {
          return $send(self, 'to_enum', ["each"].concat($to_a(args)), function $$1(){var self = $$1.$$s == null ? this : $$1.$$s;

            return self.$size()}, {$$arity: 0, $$s: self})
        };
        $send(self.enums, 'each', [], function $$2(enum$){var self = $$2.$$s == null ? this : $$2.$$s;
          if (self.iterated == null) self.iterated = nil;

          
          
          if (enum$ == null) enum$ = nil;;
          self.iterated['$<<'](enum$);
          return $send(enum$, 'each', $to_a(args), block.$to_proc());}, {$$arity: 1, $$s: self});
        return self;
      }, -1);
      
      $def(self, '$size', function $$size($a) {try {

        var $post_args, args, self = this, accum = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        accum = 0;
        $send(self.enums, 'each', [], function $$3(enum$){var size = nil;

          
          
          if (enum$ == null) enum$ = nil;;
          size = $send(enum$, 'size', $to_a(args));
          if ($truthy([nil, $$$($$$('Float'), 'INFINITY')]['$include?'](size))) {
            Opal.ret(size)
          };
          return (accum = $rb_plus(accum, size));}, 1);
        return accum;
        } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
      }, -1);
      
      $def(self, '$rewind', function $$rewind() {
        var self = this;

        
        $send(self.iterated, 'reverse_each', [], function $$4(enum$){
          
          
          if (enum$ == null) enum$ = nil;;
          if ($truthy(enum$['$respond_to?']("rewind"))) {
            return enum$.$rewind()
          } else {
            return nil
          };}, 1);
        self.iterated = [];
        return self;
      }, 0);
      return $def(self, '$inspect', function $$inspect() {
        var self = this;

        return "#<Enumerator::Chain: " + (self.enums.$inspect()) + ">"
      }, 0);
    })(self, self)
  })('::', null)
};

Opal.modules["corelib/enumerator/generator"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $breaker = Opal.breaker, $klass = Opal.klass, $truthy = Opal.truthy, $Kernel = Opal.Kernel, $def = Opal.def, $send = Opal.send;

  Opal.add_stubs('include,raise,new,to_proc');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Enumerator');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $super, $parent_nesting) {
      var self = $klass($base, $super, 'Generator');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

      $proto.block = nil;
      
      self.$include($$$('Enumerable'));
      
      $def(self, '$initialize', function $$initialize() {
        var block = $$initialize.$$p || nil, self = this;

        delete $$initialize.$$p;
        
        ;
        if (!$truthy(block)) {
          $Kernel.$raise($$$('LocalJumpError'), "no block given")
        };
        return (self.block = block);
      }, 0);
      return $def(self, '$each', function $$each($a) {
        var block = $$each.$$p || nil, $post_args, args, self = this, yielder = nil;

        delete $$each.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        yielder = $send($$('Yielder'), 'new', [], block.$to_proc());
        
        try {
          args.unshift(yielder);

          Opal.yieldX(self.block, args);
        }
        catch (e) {
          if (e === $breaker) {
            return $breaker.$v;
          }
          else {
            throw e;
          }
        }
      ;
        return self;
      }, -1);
    })($nesting[0], null, $nesting)
  })($nesting[0], null, $nesting)
};

Opal.modules["corelib/enumerator/lazy"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $coerce_to = Opal.coerce_to, $yield1 = Opal.yield1, $yieldX = Opal.yieldX, $klass = Opal.klass, $send2 = Opal.send2, $find_super = Opal.find_super, $to_a = Opal.to_a, $defs = Opal.defs, $Kernel = Opal.Kernel, $send = Opal.send, $def = Opal.def, $return_self = Opal.return_self, $Opal = Opal.Opal, $rb_lt = Opal.rb_lt, $eqeqeq = Opal.eqeqeq, $rb_plus = Opal.rb_plus, $alias = Opal.alias;

  Opal.add_stubs('raise,each,new,enumerator_size,yield,respond_to?,try_convert,<,===,+,for,class,to_proc,destructure,inspect,to_a,find_all,collect_concat,collect,enum_for');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Enumerator');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $super, $parent_nesting) {
      var self = $klass($base, $super, 'Lazy');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

      $proto.enumerator = nil;
      
      $klass(self, $$$('Exception'), 'StopLazyError');
      $defs(self, '$for', function $Lazy_for$1(object, $a) {
        var $post_args, $rest_arg, $yield = $Lazy_for$1.$$p || nil, self = this, lazy = nil;

        delete $Lazy_for$1.$$p;
        
        
        $post_args = Opal.slice.call(arguments, 1);
        
        $rest_arg = $post_args;;
        lazy = $send2(self, $find_super(self, 'for', $Lazy_for$1, false, true), 'for', [object].concat($to_a($rest_arg)), $yield);
        lazy.enumerator = object;
        return lazy;
      }, -2);
      
      $def(self, '$initialize', function $$initialize(object, size) {
        var block = $$initialize.$$p || nil, self = this;

        delete $$initialize.$$p;
        
        ;
        
        if (size == null) size = nil;;
        if (!(block !== nil)) {
          $Kernel.$raise($$$('ArgumentError'), "tried to call lazy new without a block")
        };
        self.enumerator = object;
        return $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', [size], function $$2(yielder, $a){var $post_args, each_args;

          
          
          if (yielder == null) yielder = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          each_args = $post_args;;
          try {
            return $send(object, 'each', $to_a(each_args), function $$3($b){var $post_args, args;

              
              
              $post_args = Opal.slice.call(arguments);
              
              args = $post_args;;
              
            args.unshift(yielder);

            $yieldX(block, args);
          ;}, -1)
          } catch ($err) {
            if (Opal.rescue($err, [$$('StopLazyError')])) {
              try {
                return nil
              } finally { Opal.pop_exception(); }
            } else { throw $err; }
          };}, -2);
      }, -2);
      
      $def(self, '$lazy', $return_self, 0);
      
      $def(self, '$collect', function $$collect() {
        var block = $$collect.$$p || nil, self = this;

        delete $$collect.$$p;
        
        ;
        if (!$truthy(block)) {
          $Kernel.$raise($$$('ArgumentError'), "tried to call lazy map without a block")
        };
        return $send($$('Lazy'), 'new', [self, self.$enumerator_size()], function $$4(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          
          var value = $yieldX(block, args);

          enum$.$yield(value);
        ;}, -2);
      }, 0);
      
      $def(self, '$collect_concat', function $$collect_concat() {
        var block = $$collect_concat.$$p || nil, self = this;

        delete $$collect_concat.$$p;
        
        ;
        if (!$truthy(block)) {
          $Kernel.$raise($$$('ArgumentError'), "tried to call lazy map without a block")
        };
        return $send($$('Lazy'), 'new', [self, nil], function $$5(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          
          var value = $yieldX(block, args);

          if ((value)['$respond_to?']("force") && (value)['$respond_to?']("each")) {
            $send((value), 'each', [], function $$6(v){
            
            
            if (v == null) v = nil;;
            return enum$.$yield(v);}, 1)
          }
          else {
            var array = $Opal.$try_convert(value, $$$('Array'), "to_ary");

            if (array === nil) {
              enum$.$yield(value);
            }
            else {
              $send((value), 'each', [], function $$7(v){
            
            
            if (v == null) v = nil;;
            return enum$.$yield(v);}, 1);
            }
          }
        ;}, -2);
      }, 0);
      
      $def(self, '$drop', function $$drop(n) {
        var self = this, current_size = nil, set_size = nil, dropped = nil;

        
        n = $coerce_to(n, $$$('Integer'), 'to_int');
        if ($truthy($rb_lt(n, 0))) {
          $Kernel.$raise($$$('ArgumentError'), "attempt to drop negative size")
        };
        current_size = self.$enumerator_size();
        set_size = ($eqeqeq($$$('Integer'), current_size) ? (($truthy($rb_lt(n, current_size)) ? (n) : (current_size))) : (current_size));
        dropped = 0;
        return $send($$('Lazy'), 'new', [self, set_size], function $$8(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          if ($truthy($rb_lt(dropped, n))) {
            return (dropped = $rb_plus(dropped, 1))
          } else {
            return $send(enum$, 'yield', $to_a(args))
          };}, -2);
      }, 1);
      
      $def(self, '$drop_while', function $$drop_while() {
        var block = $$drop_while.$$p || nil, self = this, succeeding = nil;

        delete $$drop_while.$$p;
        
        ;
        if (!$truthy(block)) {
          $Kernel.$raise($$$('ArgumentError'), "tried to call lazy drop_while without a block")
        };
        succeeding = true;
        return $send($$('Lazy'), 'new', [self, nil], function $$9(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          if ($truthy(succeeding)) {
            
            var value = $yieldX(block, args);

            if (!$truthy(value)) {
              succeeding = false;

              $send(enum$, 'yield', $to_a(args));
            }
          
          } else {
            return $send(enum$, 'yield', $to_a(args))
          };}, -2);
      }, 0);
      
      $def(self, '$enum_for', function $$enum_for($a, $b) {
        var block = $$enum_for.$$p || nil, $post_args, method, args, self = this;

        delete $$enum_for.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        if ($post_args.length > 0) method = $post_args.shift();
        if (method == null) method = "each";;
        
        args = $post_args;;
        return $send(self.$class(), 'for', [self, method].concat($to_a(args)), block.$to_proc());
      }, -1);
      
      $def(self, '$find_all', function $$find_all() {
        var block = $$find_all.$$p || nil, self = this;

        delete $$find_all.$$p;
        
        ;
        if (!$truthy(block)) {
          $Kernel.$raise($$$('ArgumentError'), "tried to call lazy select without a block")
        };
        return $send($$('Lazy'), 'new', [self, nil], function $$10(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          
          var value = $yieldX(block, args);

          if ($truthy(value)) {
            $send(enum$, 'yield', $to_a(args));
          }
        ;}, -2);
      }, 0);
      
      $def(self, '$grep', function $$grep(pattern) {
        var block = $$grep.$$p || nil, self = this;

        delete $$grep.$$p;
        
        ;
        if ($truthy(block)) {
          return $send($$('Lazy'), 'new', [self, nil], function $$11(enum$, $a){var $post_args, args;

            
            
            if (enum$ == null) enum$ = nil;;
            
            $post_args = Opal.slice.call(arguments, 1);
            
            args = $post_args;;
            
            var param = $Opal.$destructure(args),
                value = pattern['$==='](param);

            if ($truthy(value)) {
              value = $yield1(block, param);

              enum$.$yield($yield1(block, param));
            }
          ;}, -2)
        } else {
          return $send($$('Lazy'), 'new', [self, nil], function $$12(enum$, $a){var $post_args, args;

            
            
            if (enum$ == null) enum$ = nil;;
            
            $post_args = Opal.slice.call(arguments, 1);
            
            args = $post_args;;
            
            var param = $Opal.$destructure(args),
                value = pattern['$==='](param);

            if ($truthy(value)) {
              enum$.$yield(param);
            }
          ;}, -2)
        };
      }, 1);
      
      $def(self, '$reject', function $$reject() {
        var block = $$reject.$$p || nil, self = this;

        delete $$reject.$$p;
        
        ;
        if (!$truthy(block)) {
          $Kernel.$raise($$$('ArgumentError'), "tried to call lazy reject without a block")
        };
        return $send($$('Lazy'), 'new', [self, nil], function $$13(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          
          var value = $yieldX(block, args);

          if (!$truthy(value)) {
            $send(enum$, 'yield', $to_a(args));
          }
        ;}, -2);
      }, 0);
      
      $def(self, '$take', function $$take(n) {
        var self = this, current_size = nil, set_size = nil, taken = nil;

        
        n = $coerce_to(n, $$$('Integer'), 'to_int');
        if ($truthy($rb_lt(n, 0))) {
          $Kernel.$raise($$$('ArgumentError'), "attempt to take negative size")
        };
        current_size = self.$enumerator_size();
        set_size = ($eqeqeq($$$('Integer'), current_size) ? (($truthy($rb_lt(n, current_size)) ? (n) : (current_size))) : (current_size));
        taken = 0;
        return $send($$('Lazy'), 'new', [self, set_size], function $$14(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          if ($truthy($rb_lt(taken, n))) {
            
            $send(enum$, 'yield', $to_a(args));
            return (taken = $rb_plus(taken, 1));
          } else {
            return $Kernel.$raise($$('StopLazyError'))
          };}, -2);
      }, 1);
      
      $def(self, '$take_while', function $$take_while() {
        var block = $$take_while.$$p || nil, self = this;

        delete $$take_while.$$p;
        
        ;
        if (!$truthy(block)) {
          $Kernel.$raise($$$('ArgumentError'), "tried to call lazy take_while without a block")
        };
        return $send($$('Lazy'), 'new', [self, nil], function $$15(enum$, $a){var $post_args, args;

          
          
          if (enum$ == null) enum$ = nil;;
          
          $post_args = Opal.slice.call(arguments, 1);
          
          args = $post_args;;
          
          var value = $yieldX(block, args);

          if ($truthy(value)) {
            $send(enum$, 'yield', $to_a(args));
          }
          else {
            $Kernel.$raise($$('StopLazyError'));
          }
        ;}, -2);
      }, 0);
      
      $def(self, '$inspect', function $$inspect() {
        var self = this;

        return "#<" + (self.$class()) + ": " + (self.enumerator.$inspect()) + ">"
      }, 0);
      $alias(self, "force", "to_a");
      $alias(self, "filter", "find_all");
      $alias(self, "flat_map", "collect_concat");
      $alias(self, "map", "collect");
      $alias(self, "select", "find_all");
      return $alias(self, "to_enum", "enum_for");
    })(self, self, $nesting)
  })('::', null, $nesting)
};

Opal.modules["corelib/enumerator/yielder"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $breaker = Opal.breaker, $klass = Opal.klass, $def = Opal.def, $send = Opal.send, $to_a = Opal.to_a;

  Opal.add_stubs('yield,proc');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Enumerator');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $super) {
      var self = $klass($base, $super, 'Yielder');

      var $proto = self.$$prototype;

      $proto.block = nil;
      
      
      $def(self, '$initialize', function $$initialize() {
        var block = $$initialize.$$p || nil, self = this;

        delete $$initialize.$$p;
        
        ;
        self.block = block;
        return self;
      }, 0);
      
      $def(self, '$yield', function $Yielder_yield$1($a) {
        var $post_args, values, self = this;

        
        
        $post_args = Opal.slice.call(arguments);
        
        values = $post_args;;
        
        var value = Opal.yieldX(self.block, values);

        if (value === $breaker) {
          throw $breaker;
        }

        return value;
      ;
      }, -1);
      
      $def(self, '$<<', function $Yielder_$lt$lt$2(value) {
        var self = this;

        
        self.$yield(value);
        return self;
      }, 1);
      return $def(self, '$to_proc', function $$to_proc() {
        var self = this;

        return $send(self, 'proc', [], function $$3($a){var $post_args, values, self = $$3.$$s == null ? this : $$3.$$s;

          
          
          $post_args = Opal.slice.call(arguments);
          
          values = $post_args;;
          return $send(self, 'yield', $to_a(values));}, {$$arity: -1, $$s: self})
      }, 0);
    })($nesting[0], null)
  })($nesting[0], null, $nesting)
};

Opal.modules["corelib/enumerator"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $slice = Opal.slice, $coerce_to = Opal.coerce_to, $klass = Opal.klass, $defs = Opal.defs, $truthy = Opal.truthy, $send = Opal.send, $not = Opal.not, $def = Opal.def, $rb_plus = Opal.rb_plus, $to_a = Opal.to_a, $Opal = Opal.Opal, $send2 = Opal.send2, $find_super = Opal.find_super, $rb_ge = Opal.rb_ge, $Kernel = Opal.Kernel, $rb_le = Opal.rb_le, $alias = Opal.alias;

  Opal.add_stubs('require,include,allocate,new,to_proc,!,respond_to?,empty?,nil?,+,class,__send__,call,enum_for,size,destructure,map,>=,length,raise,[],peek_values,<=,next_values,inspect,any?,each_with_object,autoload');
  
  self.$require("corelib/enumerable");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Enumerator');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.size = $proto.args = $proto.object = $proto.method = $proto.values = $proto.cursor = nil;
    
    self.$include($$$('Enumerable'));
    self.$$prototype.$$is_enumerator = true;
    $defs(self, '$for', function $Enumerator_for$1(object, $a, $b) {
      var block = $Enumerator_for$1.$$p || nil, $post_args, method, args, self = this;

      delete $Enumerator_for$1.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      if ($post_args.length > 0) method = $post_args.shift();
      if (method == null) method = "each";;
      
      args = $post_args;;
      
      var obj = self.$allocate();

      obj.object = object;
      obj.size   = block;
      obj.method = method;
      obj.args   = args;
      obj.cursor = 0;

      return obj;
    ;
    }, -2);
    
    $def(self, '$initialize', function $$initialize($a) {
      var block = $$initialize.$$p || nil, $post_args, $rest_arg, self = this;

      delete $$initialize.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      self.cursor = 0;
      if ($truthy(block)) {
        
        self.object = $send($$('Generator'), 'new', [], block.$to_proc());
        self.method = "each";
        self.args = [];
        self.size = arguments[0] || nil;
        if (($truthy(self.size) && ($not(self.size['$respond_to?']("call"))))) {
          return (self.size = $coerce_to(self.size, $$$('Integer'), 'to_int'))
        } else {
          return nil
        };
      } else {
        
        self.object = arguments[0];
        self.method = arguments[1] || "each";
        self.args = $slice.call(arguments, 2);
        return (self.size = nil);
      };
    }, -1);
    
    $def(self, '$each', function $$each($a) {
      var block = $$each.$$p || nil, $post_args, args, self = this;

      delete $$each.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if (($truthy(block['$nil?']()) && ($truthy(args['$empty?']())))) {
        return self
      };
      args = $rb_plus(self.args, args);
      if ($truthy(block['$nil?']())) {
        return $send(self.$class(), 'new', [self.object, self.method].concat($to_a(args)))
      };
      return $send(self.object, '__send__', [self.method].concat($to_a(args)), block.$to_proc());
    }, -1);
    
    $def(self, '$size', function $$size() {
      var self = this;

      if ($truthy(self.size['$respond_to?']("call"))) {
        return $send(self.size, 'call', $to_a(self.args))
      } else {
        return self.size
      }
    }, 0);
    
    $def(self, '$with_index', function $$with_index(offset) {
      var block = $$with_index.$$p || nil, self = this;

      delete $$with_index.$$p;
      
      ;
      
      if (offset == null) offset = 0;;
      offset = ($truthy(offset) ? ($coerce_to(offset, $$$('Integer'), 'to_int')) : (0));
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["with_index", offset], function $$2(){var self = $$2.$$s == null ? this : $$2.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var result, index = offset;

      self.$each.$$p = function() {
        var param = $Opal.$destructure(arguments),
            value = block(param, index);

        index++;

        return value;
      }

      return self.$each();
    ;
    }, -1);
    
    $def(self, '$each_with_index', function $$each_with_index() {
      var block = $$each_with_index.$$p || nil, self = this;

      delete $$each_with_index.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_with_index"], function $$3(){var self = $$3.$$s == null ? this : $$3.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      $send2(self, $find_super(self, 'each_with_index', $$each_with_index, false, true), 'each_with_index', [], block);
      return self.object;
    }, 0);
    
    $def(self, '$rewind', function $$rewind() {
      var self = this;

      
      self.cursor = 0;
      return self;
    }, 0);
    
    $def(self, '$peek_values', function $$peek_values() {
      var self = this, $ret_or_1 = nil;

      
      self.values = ($truthy(($ret_or_1 = self.values)) ? ($ret_or_1) : ($send(self, 'map', [], function $$4($a){var $post_args, i;

        
        
        $post_args = Opal.slice.call(arguments);
        
        i = $post_args;;
        return i;}, -1)));
      if ($truthy($rb_ge(self.cursor, self.values.$length()))) {
        $Kernel.$raise($$$('StopIteration'), "iteration reached an end")
      };
      return self.values['$[]'](self.cursor);
    }, 0);
    
    $def(self, '$peek', function $$peek() {
      var self = this, values = nil;

      
      values = self.$peek_values();
      if ($truthy($rb_le(values.$length(), 1))) {
        return values['$[]'](0)
      } else {
        return values
      };
    }, 0);
    
    $def(self, '$next_values', function $$next_values() {
      var self = this, out = nil;

      
      out = self.$peek_values();
      self.cursor = $rb_plus(self.cursor, 1);
      return out;
    }, 0);
    
    $def(self, '$next', function $$next() {
      var self = this, values = nil;

      
      values = self.$next_values();
      if ($truthy($rb_le(values.$length(), 1))) {
        return values['$[]'](0)
      } else {
        return values
      };
    }, 0);
    
    $def(self, '$feed', function $$feed(arg) {
      var self = this;

      return self.$raise($$('NotImplementedError'), "Opal doesn't support Enumerator#feed")
    }, 1);
    
    $def(self, '$+', function $Enumerator_$plus$5(other) {
      var self = this;

      return $$$($$$('Enumerator'), 'Chain').$new(self, other)
    }, 1);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this, result = nil;

      
      result = "#<" + (self.$class()) + ": " + (self.object.$inspect()) + ":" + (self.method);
      if ($truthy(self.args['$any?']())) {
        result = $rb_plus(result, "(" + (self.args.$inspect()['$[]']($$$('Range').$new(1, -2))) + ")")
      };
      return $rb_plus(result, ">");
    }, 0);
    $alias(self, "with_object", "each_with_object");
    self.$autoload("ArithmeticSequence", "corelib/enumerator/arithmetic_sequence");
    self.$autoload("Chain", "corelib/enumerator/chain");
    self.$autoload("Generator", "corelib/enumerator/generator");
    self.$autoload("Lazy", "corelib/enumerator/lazy");
    return self.$autoload("Yielder", "corelib/enumerator/yielder");
  })('::', null, $nesting);
};

Opal.modules["corelib/numeric"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $truthy = Opal.truthy, $Kernel = Opal.Kernel, $def = Opal.def, $to_ary = Opal.to_ary, $return_self = Opal.return_self, $rb_minus = Opal.rb_minus, $rb_times = Opal.rb_times, $rb_lt = Opal.rb_lt, $eqeq = Opal.eqeq, $rb_divide = Opal.rb_divide, $return_val = Opal.return_val, $Opal = Opal.Opal, $hash2 = Opal.hash2, $not = Opal.not, $send = Opal.send, $rb_ge = Opal.rb_ge, $rb_le = Opal.rb_le, $rb_plus = Opal.rb_plus, $rb_gt = Opal.rb_gt, $alias = Opal.alias;

  Opal.add_stubs('require,include,instance_of?,class,Float,respond_to?,coerce,__send__,raise,equal?,-,*,div,<,-@,ceil,to_f,denominator,to_r,==,floor,/,%,Complex,zero?,numerator,abs,arg,coerce_to!,round,<=>,compare,is_a?,!,new,enum_for,to_proc,negative?,>=,<=,+,to_i,truncate,>,angle,conj,imag,rect');
  
  self.$require("corelib/comparable");
  return (function($base, $super) {
    var self = $klass($base, $super, 'Numeric');

    
    
    self.$include($$$('Comparable'));
    
    $def(self, '$coerce', function $$coerce(other) {
      var self = this;

      
      if ($truthy(other['$instance_of?'](self.$class()))) {
        return [other, self]
      };
      return [$Kernel.$Float(other), $Kernel.$Float(self)];
    }, 1);
    
    $def(self, '$__coerced__', function $$__coerced__(method, other) {
      var $a, $b, self = this, a = nil, b = nil;

      if ($truthy(other['$respond_to?']("coerce"))) {
        
        $b = other.$coerce(self), $a = $to_ary($b), (a = ($a[0] == null ? nil : $a[0])), (b = ($a[1] == null ? nil : $a[1])), $b;
        return a.$__send__(method, b);
      } else 
      switch (method) {
        case "+":
        case "-":
        case "*":
        case "/":
        case "%":
        case "&":
        case "|":
        case "^":
        case "**":
          return $Kernel.$raise($$$('TypeError'), "" + (other.$class()) + " can't be coerced into Numeric")
        case ">":
        case ">=":
        case "<":
        case "<=":
        case "<=>":
          return $Kernel.$raise($$$('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
        default:
          return nil
      }
    }, 2);
    
    $def(self, '$<=>', function $Numeric_$lt_eq_gt$1(other) {
      var self = this;

      
      if ($truthy(self['$equal?'](other))) {
        return 0
      };
      return nil;
    }, 1);
    
    $def(self, '$+@', $return_self, 0);
    
    $def(self, '$-@', function $Numeric_$minus$$2() {
      var self = this;

      return $rb_minus(0, self)
    }, 0);
    
    $def(self, '$%', function $Numeric_$percent$3(other) {
      var self = this;

      return $rb_minus(self, $rb_times(other, self.$div(other)))
    }, 1);
    
    $def(self, '$abs', function $$abs() {
      var self = this;

      if ($rb_lt(self, 0)) {
        return self['$-@']()
      } else {
        return self
      }
    }, 0);
    
    $def(self, '$abs2', function $$abs2() {
      var self = this;

      return $rb_times(self, self)
    }, 0);
    
    $def(self, '$angle', function $$angle() {
      var self = this;

      if ($rb_lt(self, 0)) {
        return $$$($$$('Math'), 'PI')
      } else {
        return 0
      }
    }, 0);
    
    $def(self, '$ceil', function $$ceil(ndigits) {
      var self = this;

      
      
      if (ndigits == null) ndigits = 0;;
      return self.$to_f().$ceil(ndigits);
    }, -1);
    
    $def(self, '$conj', $return_self, 0);
    
    $def(self, '$denominator', function $$denominator() {
      var self = this;

      return self.$to_r().$denominator()
    }, 0);
    
    $def(self, '$div', function $$div(other) {
      var self = this;

      
      if ($eqeq(other, 0)) {
        $Kernel.$raise($$$('ZeroDivisionError'), "divided by o")
      };
      return $rb_divide(self, other).$floor();
    }, 1);
    
    $def(self, '$divmod', function $$divmod(other) {
      var self = this;

      return [self.$div(other), self['$%'](other)]
    }, 1);
    
    $def(self, '$fdiv', function $$fdiv(other) {
      var self = this;

      return $rb_divide(self.$to_f(), other)
    }, 1);
    
    $def(self, '$floor', function $$floor(ndigits) {
      var self = this;

      
      
      if (ndigits == null) ndigits = 0;;
      return self.$to_f().$floor(ndigits);
    }, -1);
    
    $def(self, '$i', function $$i() {
      var self = this;

      return $Kernel.$Complex(0, self)
    }, 0);
    
    $def(self, '$imag', $return_val(0), 0);
    
    $def(self, '$integer?', $return_val(false), 0);
    
    $def(self, '$nonzero?', function $Numeric_nonzero$ques$4() {
      var self = this;

      if ($truthy(self['$zero?']())) {
        return nil
      } else {
        return self
      }
    }, 0);
    
    $def(self, '$numerator', function $$numerator() {
      var self = this;

      return self.$to_r().$numerator()
    }, 0);
    
    $def(self, '$polar', function $$polar() {
      var self = this;

      return [self.$abs(), self.$arg()]
    }, 0);
    
    $def(self, '$quo', function $$quo(other) {
      var self = this;

      return $rb_divide($Opal['$coerce_to!'](self, $$$('Rational'), "to_r"), other)
    }, 1);
    
    $def(self, '$real', $return_self, 0);
    
    $def(self, '$real?', $return_val(true), 0);
    
    $def(self, '$rect', function $$rect() {
      var self = this;

      return [self, 0]
    }, 0);
    
    $def(self, '$round', function $$round(digits) {
      var self = this;

      
      ;
      return self.$to_f().$round(digits);
    }, -1);
    
    $def(self, '$step', function $$step($a, $b, $c) {
      var block = $$step.$$p || nil, $post_args, $kwargs, limit, step, to, by, $d, self = this, counter = nil;

      delete $$step.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      $kwargs = Opal.extract_kwargs($post_args);
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      if ($post_args.length > 0) limit = $post_args.shift();;
      
      if ($post_args.length > 0) step = $post_args.shift();;
      
      to = $kwargs.$$smap["to"];;
      
      by = $kwargs.$$smap["by"];;
      
      if (limit !== undefined && to !== undefined) {
        $Kernel.$raise($$$('ArgumentError'), "to is given twice")
      }

      if (step !== undefined && by !== undefined) {
        $Kernel.$raise($$$('ArgumentError'), "step is given twice")
      }

      if (to !== undefined) {
        limit = to;
      }

      if (by !== undefined) {
        step = by;
      }

      if (limit === undefined) {
        limit = nil;
      }

      function validateParameters() {
        if (step === nil) {
          $Kernel.$raise($$$('TypeError'), "step must be numeric")
        }

        if (step != null && step['$=='](0)) {
          $Kernel.$raise($$$('ArgumentError'), "step can't be 0")
        }

        if (step === nil || step == null) {
          step = 1;
        }

        var sign = step['$<=>'](0);

        if (sign === nil) {
          $Kernel.$raise($$$('ArgumentError'), "0 can't be coerced into " + (step.$class()))
        }

        if (limit === nil || limit == null) {
          limit = sign > 0 ? $$$($$$('Float'), 'INFINITY') : $$$($$$('Float'), 'INFINITY')['$-@']();
        }

        $Opal.$compare(self, limit)
      }

      function stepFloatSize() {
        if ((step > 0 && self > limit) || (step < 0 && self < limit)) {
          return 0;
        } else if (step === Infinity || step === -Infinity) {
          return 1;
        } else {
          var abs = Math.abs, floor = Math.floor,
              err = (abs(self) + abs(limit) + abs(limit - self)) / abs(step) * $$$($$$('Float'), 'EPSILON');

          if (err === Infinity || err === -Infinity) {
            return 0;
          } else {
            if (err > 0.5) {
              err = 0.5;
            }

            return floor((limit - self) / step + err) + 1
          }
        }
      }

      function stepSize() {
        validateParameters();

        if (step === 0) {
          return Infinity;
        }

        if (step % 1 !== 0) {
          return stepFloatSize();
        } else if ((step > 0 && self > limit) || (step < 0 && self < limit)) {
          return 0;
        } else {
          var ceil = Math.ceil, abs = Math.abs,
              lhs = abs(self - limit) + 1,
              rhs = abs(step);

          return ceil(lhs / rhs);
        }
      }

    ;
      if (!(block !== nil)) {
        if ((($not(limit) || ($truthy(limit['$is_a?']($$$('Numeric'))))) && (($not(step) || ($truthy(step['$is_a?']($$$('Numeric')))))))) {
          return $$$($$$('Enumerator'), 'ArithmeticSequence').$new([limit, step, ($truthy(to) ? ("to: ") : nil), ($truthy(by) ? ("by: ") : nil)], self)
        } else {
          return $send(self, 'enum_for', ["step", limit, step], (stepSize).$to_proc())
        }
      };
      
      validateParameters();

      var isDesc = step['$negative?'](),
          isInf = step['$=='](0) ||
                  (limit === Infinity && !isDesc) ||
                  (limit === -Infinity && isDesc);

      if (self.$$is_number && step.$$is_number && limit.$$is_number) {
        if (self % 1 === 0 && (isInf || limit % 1 === 0) && step % 1 === 0) {
          var value = self;

          if (isInf) {
            for (;; value += step) {
              block(value);
            }
          } else if (isDesc) {
            for (; value >= limit; value += step) {
              block(value);
            }
          } else {
            for (; value <= limit; value += step) {
              block(value);
            }
          }

          return self;
        } else {
          var begin = self.$to_f().valueOf();
          step = step.$to_f().valueOf();
          limit = limit.$to_f().valueOf();

          var n = stepFloatSize();

          if (!isFinite(step)) {
            if (n !== 0) block(begin);
          } else if (step === 0) {
            while (true) {
              block(begin);
            }
          } else {
            for (var i = 0; i < n; i++) {
              var d = i * step + self;
              if (step >= 0 ? limit < d : limit > d) {
                d = limit;
              }
              block(d);
            }
          }

          return self;
        }
      }
    ;
      counter = self;
      while ($truthy(isDesc ? $rb_ge(counter, limit) : $rb_le(counter, limit))) {
        
        Opal.yield1(block, counter);
        counter = $rb_plus(counter, step);
      };
    }, -1);
    
    $def(self, '$to_c', function $$to_c() {
      var self = this;

      return $Kernel.$Complex(self, 0)
    }, 0);
    
    $def(self, '$to_int', function $$to_int() {
      var self = this;

      return self.$to_i()
    }, 0);
    
    $def(self, '$truncate', function $$truncate(ndigits) {
      var self = this;

      
      
      if (ndigits == null) ndigits = 0;;
      return self.$to_f().$truncate(ndigits);
    }, -1);
    
    $def(self, '$zero?', function $Numeric_zero$ques$5() {
      var self = this;

      return self['$=='](0)
    }, 0);
    
    $def(self, '$positive?', function $Numeric_positive$ques$6() {
      var self = this;

      return $rb_gt(self, 0)
    }, 0);
    
    $def(self, '$negative?', function $Numeric_negative$ques$7() {
      var self = this;

      return $rb_lt(self, 0)
    }, 0);
    
    $def(self, '$dup', $return_self, 0);
    
    $def(self, '$clone', function $$clone($kwargs) {
      var freeze, self = this;

      
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      freeze = $kwargs.$$smap["freeze"];
      if (freeze == null) freeze = true;
      return self;
    }, -1);
    
    $def(self, '$finite?', $return_val(true), 0);
    
    $def(self, '$infinite?', $return_val(nil), 0);
    $alias(self, "arg", "angle");
    $alias(self, "conjugate", "conj");
    $alias(self, "imaginary", "imag");
    $alias(self, "magnitude", "abs");
    $alias(self, "modulo", "%");
    $alias(self, "phase", "arg");
    return $alias(self, "rectangular", "rect");
  })('::', null);
};

Opal.modules["corelib/array"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $falsy = Opal.falsy, $hash_ids = Opal.hash_ids, $yield1 = Opal.yield1, $hash_get = Opal.hash_get, $hash_put = Opal.hash_put, $hash_delete = Opal.hash_delete, $coerce_to = Opal.coerce_to, $respond_to = Opal.respond_to, $klass = Opal.klass, $defs = Opal.defs, $Kernel = Opal.Kernel, $def = Opal.def, $Opal = Opal.Opal, $eqeqeq = Opal.eqeqeq, $hash2 = Opal.hash2, $send2 = Opal.send2, $find_super = Opal.find_super, $send = Opal.send, $rb_gt = Opal.rb_gt, $rb_times = Opal.rb_times, $eqeq = Opal.eqeq, $rb_minus = Opal.rb_minus, $to_a = Opal.to_a, $to_ary = Opal.to_ary, $gvars = Opal.gvars, $rb_ge = Opal.rb_ge, $assign_ivar = Opal.assign_ivar, $rb_lt = Opal.rb_lt, $return_self = Opal.return_self, $neqeq = Opal.neqeq, $alias = Opal.alias;

  Opal.add_stubs('require,include,to_a,warn,raise,replace,respond_to?,to_ary,coerce_to?,===,join,to_str,hash,<=>,==,object_id,inspect,enum_for,class,bsearch_index,to_proc,nil?,coerce_to!,>,*,enumerator_size,empty?,size,map,equal?,dup,each,reduce,-,[],dig,eql?,length,exclude_end?,flatten,__id__,&,!,intersection,to_s,new,item,max,min,>=,**,delete_if,reverse,rotate,rand,at,keep_if,shuffle!,<,sort,sort_by,!=,times,[]=,<<,uniq,|,values,is_a?,end,begin,upto,reject,push,select,select!,collect,collect!,unshift,pristine,singleton_class');
  
  self.$require("corelib/enumerable");
  self.$require("corelib/numeric");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Array');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    self.$include($$$('Enumerable'));
    Opal.prop(self.$$prototype, '$$is_array', true);
    
    // Recent versions of V8 (> 7.1) only use an optimized implementation when Array.prototype is unmodified.
    // For instance, "array-splice.tq" has a "fast path" (ExtractFastJSArray, defined in "src/codegen/code-stub-assembler.cc")
    // but it's only enabled when "IsPrototypeInitialArrayPrototype()" is true.
    //
    // Older versions of V8 were using relatively fast JS-with-extensions code even when Array.prototype is modified:
    // https://github.com/v8/v8/blob/7.0.1/src/js/array.js#L599-L642
    //
    // In short, Array operations are slow in recent versions of V8 when the Array.prototype has been tampered.
    // So, when possible, we are using faster open-coded version to boost the performance.

    // As of V8 8.4, depending on the size of the array, this is up to ~25x times faster than Array#shift()
    // Implementation is heavily inspired by: https://github.com/nodejs/node/blob/ba684805b6c0eded76e5cd89ee00328ac7a59365/lib/internal/util.js#L341-L347
    function shiftNoArg(list) {
      var r = list[0];
      var index = 1;
      var length = list.length;
      for (; index < length; index++) {
        list[index - 1] = list[index];
      }
      list.pop();
      return r;
    }

    function toArraySubclass(obj, klass) {
      if (klass.$$name === Opal.Array) {
        return obj;
      } else {
        return klass.$allocate().$replace((obj).$to_a());
      }
    }

    // A helper for keep_if and delete_if, filter is either Opal.truthy
    // or Opal.falsy.
    function filterIf(self, filter, block) {
      var value, raised = null, updated = new Array(self.length);

      for (var i = 0, i2 = 0, length = self.length; i < length; i++) {
        if (!raised) {
          try {
            value = $yield1(block, self[i])
          } catch(error) {
            raised = error;
          }
        }

        if (raised || filter(value)) {
          updated[i2] = self[i]
          i2 += 1;
        }
      }

      if (i2 !== i) {
        self.splice.apply(self, [0, updated.length].concat(updated));
        self.splice(i2, updated.length);
      }

      if (raised) throw raised;
    }
  ;
    $defs(self, '$[]', function $Array_$$$1($a) {
      var $post_args, objects, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      objects = $post_args;;
      return toArraySubclass(objects, self);;
    }, -1);
    
    $def(self, '$initialize', function $$initialize(size, obj) {
      var block = $$initialize.$$p || nil, self = this;

      delete $$initialize.$$p;
      
      ;
      
      if (size == null) size = nil;;
      
      if (obj == null) obj = nil;;
      
      if (obj !== nil && block !== nil) {
        $Kernel.$warn("warning: block supersedes default value argument")
      }

      if (size > $$$($$$('Integer'), 'MAX')) {
        $Kernel.$raise($$$('ArgumentError'), "array size too big")
      }

      if (arguments.length > 2) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..2)")
      }

      if (arguments.length === 0) {
        self.splice(0, self.length);
        return self;
      }

      if (arguments.length === 1) {
        if (size.$$is_array) {
          self.$replace(size.$to_a())
          return self;
        } else if (size['$respond_to?']("to_ary")) {
          self.$replace(size.$to_ary())
          return self;
        }
      }

      size = $coerce_to(size, $$$('Integer'), 'to_int');

      if (size < 0) {
        $Kernel.$raise($$$('ArgumentError'), "negative array size")
      }

      self.splice(0, self.length);
      var i, value;

      if (block === nil) {
        for (i = 0; i < size; i++) {
          self.push(obj);
        }
      }
      else {
        for (i = 0, value; i < size; i++) {
          value = block(i);
          self[i] = value;
        }
      }

      return self;
    ;
    }, -1);
    $defs(self, '$try_convert', function $$try_convert(obj) {
      
      return $Opal['$coerce_to?'](obj, $$$('Array'), "to_ary")
    }, 1);
    
    $def(self, '$&', function $Array_$$2(other) {
      var self = this;

      
      other = ($eqeqeq($$$('Array'), other) ? (other.$to_a()) : (($coerce_to(other, $$$('Array'), 'to_ary')).$to_a()));
      
      var result = [], hash = $hash2([], {}), i, length, item;

      for (i = 0, length = other.length; i < length; i++) {
        $hash_put(hash, other[i], true);
      }

      for (i = 0, length = self.length; i < length; i++) {
        item = self[i];
        if ($hash_delete(hash, item) !== undefined) {
          result.push(item);
        }
      }

      return result;
    ;
    }, 1);
    
    $def(self, '$|', function $Array_$$3(other) {
      var self = this;

      
      other = ($eqeqeq($$$('Array'), other) ? (other.$to_a()) : (($coerce_to(other, $$$('Array'), 'to_ary')).$to_a()));
      
      var hash = $hash2([], {}), i, length, item;

      for (i = 0, length = self.length; i < length; i++) {
        $hash_put(hash, self[i], true);
      }

      for (i = 0, length = other.length; i < length; i++) {
        $hash_put(hash, other[i], true);
      }

      return hash.$keys();
    ;
    }, 1);
    
    $def(self, '$*', function $Array_$$4(other) {
      var self = this;

      
      if ($truthy(other['$respond_to?']("to_str"))) {
        return self.$join(other.$to_str())
      };
      other = $coerce_to(other, $$$('Integer'), 'to_int');
      if ($truthy(other < 0)) {
        $Kernel.$raise($$$('ArgumentError'), "negative argument")
      };
      
      var result = [],
          converted = self.$to_a();

      for (var i = 0; i < other; i++) {
        result = result.concat(converted);
      }

      return result;
    ;
    }, 1);
    
    $def(self, '$+', function $Array_$plus$5(other) {
      var self = this;

      
      other = ($eqeqeq($$$('Array'), other) ? (other.$to_a()) : (($coerce_to(other, $$$('Array'), 'to_ary')).$to_a()));
      return self.concat(other);;
    }, 1);
    
    $def(self, '$-', function $Array_$minus$6(other) {
      var self = this;

      
      other = ($eqeqeq($$$('Array'), other) ? (other.$to_a()) : (($coerce_to(other, $$$('Array'), 'to_ary')).$to_a()));
      if ($truthy(self.length === 0)) {
        return []
      };
      if ($truthy(other.length === 0)) {
        return self.slice()
      };
      
      var result = [], hash = $hash2([], {}), i, length, item;

      for (i = 0, length = other.length; i < length; i++) {
        $hash_put(hash, other[i], true);
      }

      for (i = 0, length = self.length; i < length; i++) {
        item = self[i];
        if ($hash_get(hash, item) === undefined) {
          result.push(item);
        }
      }

      return result;
    ;
    }, 1);
    
    $def(self, '$<<', function $Array_$lt$lt$7(object) {
      var self = this;

      
      self.push(object);
      return self;
    }, 1);
    
    $def(self, '$<=>', function $Array_$lt_eq_gt$8(other) {
      var self = this;

      
      if ($eqeqeq($$$('Array'), other)) {
        other = other.$to_a()
      } else if ($truthy(other['$respond_to?']("to_ary"))) {
        other = other.$to_ary().$to_a()
      } else {
        return nil
      };
      
      if (self.$hash() === other.$hash()) {
        return 0;
      }

      var count = Math.min(self.length, other.length);

      for (var i = 0; i < count; i++) {
        var tmp = (self[i])['$<=>'](other[i]);

        if (tmp !== 0) {
          return tmp;
        }
      }

      return (self.length)['$<=>'](other.length);
    ;
    }, 1);
    
    $def(self, '$==', function $Array_$eq_eq$9(other) {
      var self = this;

      
      var recursed = {};

      function _eqeq(array, other) {
        var i, length, a, b;

        if (array === other)
          return true;

        if (!other.$$is_array) {
          if ($respond_to(other, '$to_ary')) {
            return (other)['$=='](array);
          } else {
            return false;
          }
        }

        if (array.$$constructor !== Array)
          array = (array).$to_a();
        if (other.$$constructor !== Array)
          other = (other).$to_a();

        if (array.length !== other.length) {
          return false;
        }

        recursed[(array).$object_id()] = true;

        for (i = 0, length = array.length; i < length; i++) {
          a = array[i];
          b = other[i];
          if (a.$$is_array) {
            if (b.$$is_array && b.length !== a.length) {
              return false;
            }
            if (!recursed.hasOwnProperty((a).$object_id())) {
              if (!_eqeq(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$=='](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eqeq(self, other);
    
    }, 1);
    
    function $array_slice_range(self, index) {
      var size = self.length,
          exclude, from, to, result;

      exclude = index.excl;
      from    = index.begin === nil ? 0 : $coerce_to(index.begin, Opal.Integer, 'to_int');
      to      = index.end === nil ? -1 : $coerce_to(index.end, Opal.Integer, 'to_int');

      if (from < 0) {
        from += size;

        if (from < 0) {
          return nil;
        }
      }

      if (index.excl_rev && index.begin !== nil) {
        from += 1;
      }

      if (from > size) {
        return nil;
      }

      if (to < 0) {
        to += size;

        if (to < 0) {
          return [];
        }
      }

      if (!exclude || index.end === nil) {
        to += 1;
      }

      result = self.slice(from, to);
      return result;
    }

    function $array_slice_arithmetic_seq(self, index) {
      var array, out = [], i = 0, pseudorange;

      if (index.step < 0) {
        pseudorange = {
          begin: index.range.end,
          end: index.range.begin,
          excl: false,
          excl_rev: index.range.excl
        };
        array = $array_slice_range(self, pseudorange).$reverse();
      }
      else {
        array = $array_slice_range(self, index.range);
      }

      while (i < array.length) {
        out.push(array[i]);
        i += Math.abs(index.step);
      }

      return out;
    }

    function $array_slice_index_length(self, index, length) {
      var size = self.length,
          exclude, from, to, result;

      index = $coerce_to(index, Opal.Integer, 'to_int');

      if (index < 0) {
        index += size;

        if (index < 0) {
          return nil;
        }
      }

      if (length === undefined) {
        if (index >= size || index < 0) {
          return nil;
        }

        return self[index];
      }
      else {
        length = $coerce_to(length, Opal.Integer, 'to_int');

        if (length < 0 || index > size || index < 0) {
          return nil;
        }

        result = self.slice(index, index + length);
      }
      return result;
    }
  ;
    
    $def(self, '$[]', function $Array_$$$10(index, length) {
      var self = this;

      
      ;
      
      if (index.$$is_range) {
        return $array_slice_range(self, index);
      }
      else if (index.$$is_arithmetic_seq) {
        return $array_slice_arithmetic_seq(self, index);
      }
      else {
        return $array_slice_index_length(self, index, length);
      }
    ;
    }, -2);
    
    $def(self, '$[]=', function $Array_$$$eq$11(index, value, extra) {
      var self = this, data = nil, length = nil;

      
      ;
      data = nil;
      
      var i, size = self.length;

      if (index.$$is_range) {
        if (value.$$is_array)
          data = value.$to_a();
        else if (value['$respond_to?']("to_ary"))
          data = value.$to_ary().$to_a();
        else
          data = [value];

        var exclude = index.excl,
            from    = index.begin === nil ? 0 : $coerce_to(index.begin, Opal.Integer, 'to_int'),
            to      = index.end === nil ? -1 : $coerce_to(index.end, Opal.Integer, 'to_int');

        if (from < 0) {
          from += size;

          if (from < 0) {
            $Kernel.$raise($$$('RangeError'), "" + (index.$inspect()) + " out of range");
          }
        }

        if (to < 0) {
          to += size;
        }

        if (!exclude || index.end === nil) {
          to += 1;
        }

        if (from > size) {
          for (i = size; i < from; i++) {
            self[i] = nil;
          }
        }

        if (to < 0) {
          self.splice.apply(self, [from, 0].concat(data));
        }
        else {
          self.splice.apply(self, [from, to - from].concat(data));
        }

        return value;
      } else {
        if (extra === undefined) {
          (length = 1)
        } else {
          length = value;
          value  = extra;

          if (value.$$is_array)
            data = value.$to_a();
          else if (value['$respond_to?']("to_ary"))
            data = value.$to_ary().$to_a();
          else
            data = [value];
        }

        var old;

        index  = $coerce_to(index, $$$('Integer'), 'to_int');
        length = $coerce_to(length, $$$('Integer'), 'to_int');

        if (index < 0) {
          old    = index;
          index += size;

          if (index < 0) {
            $Kernel.$raise($$$('IndexError'), "index " + (old) + " too small for array; minimum " + (-self.length));
          }
        }

        if (length < 0) {
          $Kernel.$raise($$$('IndexError'), "negative length (" + (length) + ")")
        }

        if (index > size) {
          for (i = size; i < index; i++) {
            self[i] = nil;
          }
        }

        if (extra === undefined) {
          self[index] = value;
        }
        else {
          self.splice.apply(self, [index, length].concat(data));
        }

        return value;
      }
    ;
    }, -3);
    
    $def(self, '$any?', function $Array_any$ques$12(pattern) {
      var block = $Array_any$ques$12.$$p || nil, self = this;

      delete $Array_any$ques$12.$$p;
      
      ;
      ;
      if (self.length === 0) return false;
      return $send2(self, $find_super(self, 'any?', $Array_any$ques$12, false, true), 'any?', [pattern], block);
    }, -1);
    
    $def(self, '$assoc', function $$assoc(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        if (item = self[i], item.length && (item[0])['$=='](object)) {
          return item;
        }
      }

      return nil;
    
    }, 1);
    
    $def(self, '$at', function $$at(index) {
      var self = this;

      
      index = $coerce_to(index, $$$('Integer'), 'to_int')

      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self[index];
    
    }, 1);
    
    $def(self, '$bsearch_index', function $$bsearch_index() {
      var block = $$bsearch_index.$$p || nil, self = this;

      delete $$bsearch_index.$$p;
      
      ;
      if (!(block !== nil)) {
        return self.$enum_for("bsearch_index")
      };
      
      var min = 0,
          max = self.length,
          mid,
          val,
          ret,
          smaller = false,
          satisfied = nil;

      while (min < max) {
        mid = min + Math.floor((max - min) / 2);
        val = self[mid];
        ret = $yield1(block, val);

        if (ret === true) {
          satisfied = mid;
          smaller = true;
        }
        else if (ret === false || ret === nil) {
          smaller = false;
        }
        else if (ret.$$is_number) {
          if (ret === 0) { return mid; }
          smaller = (ret < 0);
        }
        else {
          $Kernel.$raise($$$('TypeError'), "wrong argument type " + ((ret).$class()) + " (must be numeric, true, false or nil)")
        }

        if (smaller) { max = mid; } else { min = mid + 1; }
      }

      return satisfied;
    ;
    }, 0);
    
    $def(self, '$bsearch', function $$bsearch() {
      var block = $$bsearch.$$p || nil, self = this, index = nil;

      delete $$bsearch.$$p;
      
      ;
      if (!(block !== nil)) {
        return self.$enum_for("bsearch")
      };
      index = $send(self, 'bsearch_index', [], block.$to_proc());
      
      if (index != null && index.$$is_number) {
        return self[index];
      } else {
        return index;
      }
    ;
    }, 0);
    
    $def(self, '$cycle', function $$cycle(n) {
      var block = $$cycle.$$p || nil, self = this;

      delete $$cycle.$$p;
      
      ;
      
      if (n == null) n = nil;;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["cycle", n], function $$13(){var self = $$13.$$s == null ? this : $$13.$$s;

          if ($truthy(n['$nil?']())) {
            return $$$($$$('Float'), 'INFINITY')
          } else {
            
            n = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
            if ($truthy($rb_gt(n, 0))) {
              return $rb_times(self.$enumerator_size(), n)
            } else {
              return 0
            };
          }}, {$$arity: 0, $$s: self})
      };
      if (($truthy(self['$empty?']()) || ($eqeq(n, 0)))) {
        return nil
      };
      
      var i, length, value;

      if (n === nil) {
        while (true) {
          for (i = 0, length = self.length; i < length; i++) {
            value = $yield1(block, self[i]);
          }
        }
      }
      else {
        n = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
        if (n <= 0) {
          return self;
        }

        while (n > 0) {
          for (i = 0, length = self.length; i < length; i++) {
            value = $yield1(block, self[i]);
          }

          n--;
        }
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$clear', function $$clear() {
      var self = this;

      
      self.splice(0, self.length);
      return self;
    }, 0);
    
    $def(self, '$count', function $$count(object) {
      var block = $$count.$$p || nil, self = this;

      delete $$count.$$p;
      
      ;
      ;
      if (($truthy(object !== undefined) || ($truthy(block)))) {
        return $send2(self, $find_super(self, 'count', $$count, false, true), 'count', [object], block)
      } else {
        return self.$size()
      };
    }, -1);
    
    $def(self, '$initialize_copy', function $$initialize_copy(other) {
      var self = this;

      return self.$replace(other)
    }, 1);
    
    $def(self, '$collect', function $$collect() {
      var block = $$collect.$$p || nil, self = this;

      delete $$collect.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["collect"], function $$14(){var self = $$14.$$s == null ? this : $$14.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var value = $yield1(block, self[i]);
        result.push(value);
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$collect!', function $Array_collect$excl$15() {
      var block = $Array_collect$excl$15.$$p || nil, self = this;

      delete $Array_collect$excl$15.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["collect!"], function $$16(){var self = $$16.$$s == null ? this : $$16.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = $yield1(block, self[i]);
        self[i] = value;
      }
    ;
      return self;
    }, 0);
    
    function binomial_coefficient(n, k) {
      if (n === k || k === 0) {
        return 1;
      }

      if (k > 0 && n > k) {
        return binomial_coefficient(n - 1, k - 1) + binomial_coefficient(n - 1, k);
      }

      return 0;
    }
  ;
    
    $def(self, '$combination', function $$combination(n) {
      var $yield = $$combination.$$p || nil, self = this, num = nil;

      delete $$combination.$$p;
      
      num = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
      if (!($yield !== nil)) {
        return $send(self, 'enum_for', ["combination", num], function $$17(){var self = $$17.$$s == null ? this : $$17.$$s;

          return binomial_coefficient(self.length, num)}, {$$arity: 0, $$s: self})
      };
      
      var i, length, stack, chosen, lev, done, next;

      if (num === 0) {
        Opal.yield1($yield, [])
      } else if (num === 1) {
        for (i = 0, length = self.length; i < length; i++) {
          Opal.yield1($yield, [self[i]])
        }
      }
      else if (num === self.length) {
        Opal.yield1($yield, self.slice())
      }
      else if (num >= 0 && num < self.length) {
        stack = [];
        for (i = 0; i <= num + 1; i++) {
          stack.push(0);
        }

        chosen = [];
        lev = 0;
        done = false;
        stack[0] = -1;

        while (!done) {
          chosen[lev] = self[stack[lev+1]];
          while (lev < num - 1) {
            lev++;
            next = stack[lev+1] = stack[lev] + 1;
            chosen[lev] = self[next];
          }
          Opal.yield1($yield, chosen.slice())
          lev++;
          do {
            done = (lev === 0);
            stack[lev]++;
            lev--;
          } while ( stack[lev+1] + num === self.length + lev + 1 );
        }
      }
    ;
      return self;
    }, 1);
    
    $def(self, '$repeated_combination', function $$repeated_combination(n) {
      var $yield = $$repeated_combination.$$p || nil, self = this, num = nil;

      delete $$repeated_combination.$$p;
      
      num = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
      if (!($yield !== nil)) {
        return $send(self, 'enum_for', ["repeated_combination", num], function $$18(){var self = $$18.$$s == null ? this : $$18.$$s;

          return binomial_coefficient(self.length + num - 1, num);}, {$$arity: 0, $$s: self})
      };
      
      function iterate(max, from, buffer, self) {
        if (buffer.length == max) {
          var copy = buffer.slice();
          Opal.yield1($yield, copy)
          return;
        }
        for (var i = from; i < self.length; i++) {
          buffer.push(self[i]);
          iterate(max, i, buffer, self);
          buffer.pop();
        }
      }

      if (num >= 0) {
        iterate(num, 0, [], self);
      }
    ;
      return self;
    }, 1);
    
    $def(self, '$compact', function $$compact() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length, item; i < length; i++) {
        if ((item = self[i]) !== nil) {
          result.push(item);
        }
      }

      return result;
    
    }, 0);
    
    $def(self, '$compact!', function $Array_compact$excl$19() {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = self.length; i < length; i++) {
        if (self[i] === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    }, 0);
    
    $def(self, '$concat', function $$concat($a) {
      var $post_args, others, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      others = $post_args;;
      others = $send(others, 'map', [], function $$20(other){var self = $$20.$$s == null ? this : $$20.$$s;

        
        
        if (other == null) other = nil;;
        other = ($eqeqeq($$$('Array'), other) ? (other.$to_a()) : (($coerce_to(other, $$$('Array'), 'to_ary')).$to_a()));
        if ($truthy(other['$equal?'](self))) {
          other = other.$dup()
        };
        return other;}, {$$arity: 1, $$s: self});
      $send(others, 'each', [], function $$21(other){var self = $$21.$$s == null ? this : $$21.$$s;

        
        
        if (other == null) other = nil;;
        
        for (var i = 0, length = other.length; i < length; i++) {
          self.push(other[i]);
        }
      ;}, {$$arity: 1, $$s: self});
      return self;
    }, -1);
    
    $def(self, '$delete', function $Array_delete$22(object) {
      var $yield = $Array_delete$22.$$p || nil, self = this;

      delete $Array_delete$22.$$p;
      
      var original = self.length;

      for (var i = 0, length = original; i < length; i++) {
        if ((self[i])['$=='](object)) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      if (self.length === original) {
        if (($yield !== nil)) {
          return Opal.yieldX($yield, []);
        }
        return nil;
      }
      return object;
    
    }, 1);
    
    $def(self, '$delete_at', function $$delete_at(index) {
      var self = this;

      
      index = $coerce_to(index, $$$('Integer'), 'to_int');

      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      var result = self[index];

      self.splice(index, 1);

      return result;
    
    }, 1);
    
    $def(self, '$delete_if', function $$delete_if() {
      var block = $$delete_if.$$p || nil, self = this;

      delete $$delete_if.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["delete_if"], function $$23(){var self = $$23.$$s == null ? this : $$23.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      filterIf(self, $falsy, block);
      return self;
    }, 0);
    
    $def(self, '$difference', function $$difference($a) {
      var $post_args, arrays, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      arrays = $post_args;;
      return $send(arrays, 'reduce', [self.$to_a().$dup()], function $$24(a, b){
        
        
        if (a == null) a = nil;;
        
        if (b == null) b = nil;;
        return $rb_minus(a, b);}, 2);
    }, -1);
    
    $def(self, '$dig', function $$dig(idx, $a) {
      var $post_args, idxs, self = this, item = nil;

      
      
      $post_args = Opal.slice.call(arguments, 1);
      
      idxs = $post_args;;
      item = self['$[]'](idx);
      
      if (item === nil || idxs.length === 0) {
        return item;
      }
    ;
      if (!$truthy(item['$respond_to?']("dig"))) {
        $Kernel.$raise($$$('TypeError'), "" + (item.$class()) + " does not have #dig method")
      };
      return $send(item, 'dig', $to_a(idxs));
    }, -2);
    
    $def(self, '$drop', function $$drop(number) {
      var self = this;

      
      number = $coerce_to(number, $$$('Integer'), 'to_int');

      if (number < 0) {
        $Kernel.$raise($$$('ArgumentError'))
      }

      return self.slice(number);
    
    }, 1);
    
    $def(self, '$dup', function $$dup() {
      var $yield = $$dup.$$p || nil, self = this;

      delete $$dup.$$p;
      
      
      if (self.$$class === Opal.Array &&
          self.$$class.$allocate.$$pristine &&
          self.$copy_instance_variables.$$pristine &&
          self.$initialize_dup.$$pristine) {
        return self.slice(0);
      }
    ;
      return $send2(self, $find_super(self, 'dup', $$dup, false, true), 'dup', [], $yield);
    }, 0);
    
    $def(self, '$each', function $$each() {
      var block = $$each.$$p || nil, self = this;

      delete $$each.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each"], function $$25(){var self = $$25.$$s == null ? this : $$25.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = $yield1(block, self[i]);
      }
    ;
      return self;
    }, 0);
    
    $def(self, '$each_index', function $$each_index() {
      var block = $$each_index.$$p || nil, self = this;

      delete $$each_index.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_index"], function $$26(){var self = $$26.$$s == null ? this : $$26.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = $yield1(block, i);
      }
    ;
      return self;
    }, 0);
    
    $def(self, '$empty?', function $Array_empty$ques$27() {
      var self = this;

      return self.length === 0;
    }, 0);
    
    $def(self, '$eql?', function $Array_eql$ques$28(other) {
      var self = this;

      
      var recursed = {};

      function _eql(array, other) {
        var i, length, a, b;

        if (!other.$$is_array) {
          return false;
        }

        other = other.$to_a();

        if (array.length !== other.length) {
          return false;
        }

        recursed[(array).$object_id()] = true;

        for (i = 0, length = array.length; i < length; i++) {
          a = array[i];
          b = other[i];
          if (a.$$is_array) {
            if (b.$$is_array && b.length !== a.length) {
              return false;
            }
            if (!recursed.hasOwnProperty((a).$object_id())) {
              if (!_eql(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$eql?'](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eql(self, other);
    
    }, 1);
    
    $def(self, '$fetch', function $$fetch(index, defaults) {
      var block = $$fetch.$$p || nil, self = this;

      delete $$fetch.$$p;
      
      ;
      ;
      
      var original = index;

      index = $coerce_to(index, $$$('Integer'), 'to_int');

      if (index < 0) {
        index += self.length;
      }

      if (index >= 0 && index < self.length) {
        return self[index];
      }

      if (block !== nil && defaults != null) {
        self.$warn("warning: block supersedes default value argument")
      }

      if (block !== nil) {
        return block(original);
      }

      if (defaults != null) {
        return defaults;
      }

      if (self.length === 0) {
        $Kernel.$raise($$$('IndexError'), "index " + (original) + " outside of array bounds: 0...0")
      }
      else {
        $Kernel.$raise($$$('IndexError'), "index " + (original) + " outside of array bounds: -" + (self.length) + "..." + (self.length));
      }
    ;
    }, -2);
    
    $def(self, '$fill', function $$fill($a) {
      var block = $$fill.$$p || nil, $post_args, args, $b, $c, self = this, one = nil, two = nil, obj = nil, left = nil, right = nil;

      delete $$fill.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
            var i, length, value;;
      if ($truthy(block)) {
        
        if ($truthy(args.length > 2)) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 0..2)")
        };
        $c = args, $b = $to_ary($c), (one = ($b[0] == null ? nil : $b[0])), (two = ($b[1] == null ? nil : $b[1])), $c;
      } else {
        
        if ($truthy(args.length == 0)) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        } else if ($truthy(args.length > 3)) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 1..3)")
        };
        $c = args, $b = $to_ary($c), (obj = ($b[0] == null ? nil : $b[0])), (one = ($b[1] == null ? nil : $b[1])), (two = ($b[2] == null ? nil : $b[2])), $c;
      };
      if ($eqeqeq($$$('Range'), one)) {
        
        if ($truthy(two)) {
          $Kernel.$raise($$$('TypeError'), "length invalid with range")
        };
        left = one.begin === nil ? 0 : $coerce_to(one.begin, $$$('Integer'), 'to_int');
        if ($truthy(left < 0)) {
          left += this.length
        };
        if ($truthy(left < 0)) {
          $Kernel.$raise($$$('RangeError'), "" + (one.$inspect()) + " out of range")
        };
        right = one.end === nil ? -1 : $coerce_to(one.end, $$$('Integer'), 'to_int');
        if ($truthy(right < 0)) {
          right += this.length
        };
        if (!$truthy(one['$exclude_end?']())) {
          right += 1
        };
        if ($truthy(right <= left)) {
          return self
        };
      } else if ($truthy(one)) {
        
        left = $coerce_to(one, $$$('Integer'), 'to_int');
        if ($truthy(left < 0)) {
          left += this.length
        };
        if ($truthy(left < 0)) {
          left = 0
        };
        if ($truthy(two)) {
          
          right = $coerce_to(two, $$$('Integer'), 'to_int');
          if ($truthy(right == 0)) {
            return self
          };
          right += left;
        } else {
          right = this.length
        };
      } else {
        
        left = 0;
        right = this.length;
      };
      if ($truthy(left > this.length)) {
        
        for (i = this.length; i < right; i++) {
          self[i] = nil;
        }
      
      };
      if ($truthy(right > this.length)) {
        this.length = right
      };
      if ($truthy(block)) {
        
        for (length = this.length; left < right; left++) {
          value = block(left);
          self[left] = value;
        }
      
      } else {
        
        for (length = this.length; left < right; left++) {
          self[left] = obj;
        }
      
      };
      return self;
    }, -1);
    
    $def(self, '$first', function $$first(count) {
      var self = this;

      
      ;
      
      if (count == null) {
        return self.length === 0 ? nil : self[0];
      }

      count = $coerce_to(count, $$$('Integer'), 'to_int');

      if (count < 0) {
        $Kernel.$raise($$$('ArgumentError'), "negative array size");
      }

      return self.slice(0, count);
    ;
    }, -1);
    
    $def(self, '$flatten', function $$flatten(level) {
      var self = this;

      
      ;
      
      function _flatten(array, level) {
        var result = [],
            i, length,
            item, ary;

        array = (array).$to_a();

        for (i = 0, length = array.length; i < length; i++) {
          item = array[i];

          if (!$respond_to(item, '$to_ary', true)) {
            result.push(item);
            continue;
          }

          ary = (item).$to_ary();

          if (ary === nil) {
            result.push(item);
            continue;
          }

          if (!ary.$$is_array) {
            $Kernel.$raise($$$('TypeError'));
          }

          if (ary === self) {
            $Kernel.$raise($$$('ArgumentError'));
          }

          switch (level) {
          case undefined:
            result = result.concat(_flatten(ary));
            break;
          case 0:
            result.push(ary);
            break;
          default:
            result.push.apply(result, _flatten(ary, level - 1));
          }
        }
        return result;
      }

      if (level !== undefined) {
        level = $coerce_to(level, $$$('Integer'), 'to_int');
      }

      return _flatten(self, level);
    ;
    }, -1);
    
    $def(self, '$flatten!', function $Array_flatten$excl$29(level) {
      var self = this;

      
      ;
      
      var flattened = self.$flatten(level);

      if (self.length == flattened.length) {
        for (var i = 0, length = self.length; i < length; i++) {
          if (self[i] !== flattened[i]) {
            break;
          }
        }

        if (i == length) {
          return nil;
        }
      }

      self.$replace(flattened);
    ;
      return self;
    }, -1);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      
      var top = ($hash_ids === undefined),
          result = ['A'],
          hash_id = self.$object_id(),
          item, i, key;

      try {
        if (top) {
          $hash_ids = Object.create(null);
        }

        // return early for recursive structures
        if ($hash_ids[hash_id]) {
          return 'self';
        }

        for (key in $hash_ids) {
          item = $hash_ids[key];
          if (self['$eql?'](item)) {
            return 'self';
          }
        }

        $hash_ids[hash_id] = self;

        for (i = 0; i < self.length; i++) {
          item = self[i];
          result.push(item.$hash());
        }

        return result.join(',');
      } finally {
        if (top) {
          $hash_ids = undefined;
        }
      }
    
    }, 0);
    
    $def(self, '$include?', function $Array_include$ques$30(member) {
      var self = this;

      
      for (var i = 0, length = self.length; i < length; i++) {
        if ((self[i])['$=='](member)) {
          return true;
        }
      }

      return false;
    
    }, 1);
    
    $def(self, '$index', function $$index(object) {
      var block = $$index.$$p || nil, self = this;

      delete $$index.$$p;
      
      ;
      ;
      
      var i, length, value;

      if (object != null && block !== nil) {
        self.$warn("warning: given block not used")
      }

      if (object != null) {
        for (i = 0, length = self.length; i < length; i++) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (i = 0, length = self.length; i < length; i++) {
          value = block(self[i]);

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else {
        return self.$enum_for("index");
      }

      return nil;
    ;
    }, -1);
    
    $def(self, '$insert', function $$insert(index, $a) {
      var $post_args, objects, self = this;

      
      
      $post_args = Opal.slice.call(arguments, 1);
      
      objects = $post_args;;
      
      index = $coerce_to(index, $$$('Integer'), 'to_int');

      if (objects.length > 0) {
        if (index < 0) {
          index += self.length + 1;

          if (index < 0) {
            $Kernel.$raise($$$('IndexError'), "" + (index) + " is out of bounds");
          }
        }
        if (index > self.length) {
          for (var i = self.length; i < index; i++) {
            self.push(nil);
          }
        }

        self.splice.apply(self, [index, 0].concat(objects));
      }
    ;
      return self;
    }, -2);
    var inspect_stack = [];
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      
      
      var result = [],
      id = self.$__id__(),
      pushed = true;
    ;
      
      return (function() { try {
      
      
        if (inspect_stack.indexOf(id) !== -1) {
          pushed = false;
          return '[...]';
        }
        inspect_stack.push(id)

        for (var i = 0, length = self.length; i < length; i++) {
          var item = self['$[]'](i);

          result.push($$('Opal').$inspect(item));
        }

        return '[' + result.join(', ') + ']';
      ;
      return nil;
      } finally {
        if (pushed) inspect_stack.pop()
      }; })();;
    }, 0);
    
    $def(self, '$intersection', function $$intersection($a) {
      var $post_args, arrays, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      arrays = $post_args;;
      return $send(arrays, 'reduce', [self.$to_a().$dup()], function $$31(a, b){
        
        
        if (a == null) a = nil;;
        
        if (b == null) b = nil;;
        return a['$&'](b);}, 2);
    }, -1);
    
    $def(self, '$intersect?', function $Array_intersect$ques$32(other) {
      var self = this;

      return self.$intersection(other)['$empty?']()['$!']()
    }, 1);
    
    $def(self, '$join', function $$join(sep) {
      var self = this;
      if ($gvars[","] == null) $gvars[","] = nil;

      
      
      if (sep == null) sep = nil;;
      if ($truthy(self.length === 0)) {
        return ""
      };
      if ($truthy(sep === nil)) {
        sep = $gvars[","]
      };
      
      var result = [];
      var i, length, item, tmp;

      for (i = 0, length = self.length; i < length; i++) {
        item = self[i];

        if ($respond_to(item, '$to_str')) {
          tmp = (item).$to_str();

          if (tmp !== nil) {
            result.push((tmp).$to_s());

            continue;
          }
        }

        if ($respond_to(item, '$to_ary')) {
          tmp = (item).$to_ary();

          if (tmp === self) {
            $Kernel.$raise($$$('ArgumentError'));
          }

          if (tmp !== nil) {
            result.push((tmp).$join(sep));

            continue;
          }
        }

        if ($respond_to(item, '$to_s')) {
          tmp = (item).$to_s();

          if (tmp !== nil) {
            result.push(tmp);

            continue;
          }
        }

        $Kernel.$raise($$$('NoMethodError').$new("" + ($$('Opal').$inspect(self.$item())) + " doesn't respond to #to_str, #to_ary or #to_s", "to_str"));
      }

      if (sep === nil) {
        return result.join('');
      }
      else {
        return result.join($Opal['$coerce_to!'](sep, $$$('String'), "to_str").$to_s());
      }
    ;
    }, -1);
    
    $def(self, '$keep_if', function $$keep_if() {
      var block = $$keep_if.$$p || nil, self = this;

      delete $$keep_if.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["keep_if"], function $$33(){var self = $$33.$$s == null ? this : $$33.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      filterIf(self, $truthy, block);
      return self;
    }, 0);
    
    $def(self, '$last', function $$last(count) {
      var self = this;

      
      ;
      
      if (count == null) {
        return self.length === 0 ? nil : self[self.length - 1];
      }

      count = $coerce_to(count, $$$('Integer'), 'to_int');

      if (count < 0) {
        $Kernel.$raise($$$('ArgumentError'), "negative array size");
      }

      if (count > self.length) {
        count = self.length;
      }

      return self.slice(self.length - count, self.length);
    ;
    }, -1);
    
    $def(self, '$length', function $$length() {
      var self = this;

      return self.length;
    }, 0);
    
    $def(self, '$max', function $$max(n) {
      var block = $$max.$$p || nil, self = this;

      delete $$max.$$p;
      
      ;
      ;
      return $send(self.$each(), 'max', [n], block.$to_proc());
    }, -1);
    
    $def(self, '$min', function $$min() {
      var block = $$min.$$p || nil, self = this;

      delete $$min.$$p;
      
      ;
      return $send(self.$each(), 'min', [], block.$to_proc());
    }, 0);
    
    // Returns the product of from, from-1, ..., from - how_many + 1.
    function descending_factorial(from, how_many) {
      var count = how_many >= 0 ? 1 : 0;
      while (how_many) {
        count *= from;
        from--;
        how_many--;
      }
      return count;
    }
  ;
    
    $def(self, '$permutation', function $$permutation(num) {
      var block = $$permutation.$$p || nil, self = this, perm = nil, used = nil;

      delete $$permutation.$$p;
      
      ;
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["permutation", num], function $$34(){var self = $$34.$$s == null ? this : $$34.$$s;

          return descending_factorial(self.length, num === undefined ? self.length : num);}, {$$arity: 0, $$s: self})
      };
      
      var permute, offensive, output;

      if (num === undefined) {
        num = self.length;
      }
      else {
        num = $coerce_to(num, $$$('Integer'), 'to_int');
      }

      if (num < 0 || self.length < num) {
        // no permutations, yield nothing
      }
      else if (num === 0) {
        // exactly one permutation: the zero-length array
        Opal.yield1(block, [])
      }
      else if (num === 1) {
        // this is a special, easy case
        for (var i = 0; i < self.length; i++) {
          Opal.yield1(block, [self[i]])
        }
      }
      else {
        // this is the general case
        (perm = $$('Array').$new(num));
        (used = $$('Array').$new(self.length, false));

        permute = function(num, perm, index, used, blk) {
          self = this;
          for(var i = 0; i < self.length; i++){
            if(used['$[]'](i)['$!']()) {
              perm[index] = i;
              if(index < num - 1) {
                used[i] = true;
                permute.call(self, num, perm, index + 1, used, blk);
                used[i] = false;
              }
              else {
                output = [];
                for (var j = 0; j < perm.length; j++) {
                  output.push(self[perm[j]]);
                }
                $yield1(blk, output);
              }
            }
          }
        }

        if ((block !== nil)) {
          // offensive (both definitions) copy.
          offensive = self.slice();
          permute.call(offensive, num, perm, 0, used, block);
        }
        else {
          permute.call(self, num, perm, 0, used, block);
        }
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$repeated_permutation', function $$repeated_permutation(n) {
      var $yield = $$repeated_permutation.$$p || nil, self = this, num = nil;

      delete $$repeated_permutation.$$p;
      
      num = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
      if (!($yield !== nil)) {
        return $send(self, 'enum_for', ["repeated_permutation", num], function $$35(){var self = $$35.$$s == null ? this : $$35.$$s;

          if ($truthy($rb_ge(num, 0))) {
            return self.$size()['$**'](num)
          } else {
            return 0
          }}, {$$arity: 0, $$s: self})
      };
      
      function iterate(max, buffer, self) {
        if (buffer.length == max) {
          var copy = buffer.slice();
          Opal.yield1($yield, copy)
          return;
        }
        for (var i = 0; i < self.length; i++) {
          buffer.push(self[i]);
          iterate(max, buffer, self);
          buffer.pop();
        }
      }

      iterate(num, [], self.slice());
    ;
      return self;
    }, 1);
    
    $def(self, '$pop', function $$pop(count) {
      var self = this;

      
      ;
      if ($truthy(count === undefined)) {
        
        if ($truthy(self.length === 0)) {
          return nil
        };
        return self.pop();
      };
      count = $coerce_to(count, $$$('Integer'), 'to_int');
      if ($truthy(count < 0)) {
        $Kernel.$raise($$$('ArgumentError'), "negative array size")
      };
      if ($truthy(self.length === 0)) {
        return []
      };
      if ($truthy(count === 1)) {
        return [self.pop()];
      } else if ($truthy(count > self.length)) {
        return self.splice(0, self.length);
      } else {
        return self.splice(self.length - count, self.length);
      };
    }, -1);
    
    $def(self, '$product', function $$product($a) {
      var block = $$product.$$p || nil, $post_args, args, self = this;

      delete $$product.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var result = (block !== nil) ? null : [],
          n = args.length + 1,
          counters = new Array(n),
          lengths  = new Array(n),
          arrays   = new Array(n),
          i, m, subarray, len, resultlen = 1;

      arrays[0] = self;
      for (i = 1; i < n; i++) {
        arrays[i] = $coerce_to(args[i - 1], $$$('Array'), 'to_ary');
      }

      for (i = 0; i < n; i++) {
        len = arrays[i].length;
        if (len === 0) {
          return result || self;
        }
        resultlen *= len;
        if (resultlen > 2147483647) {
          $Kernel.$raise($$$('RangeError'), "too big to product")
        }
        lengths[i] = len;
        counters[i] = 0;
      }

      outer_loop: for (;;) {
        subarray = [];
        for (i = 0; i < n; i++) {
          subarray.push(arrays[i][counters[i]]);
        }
        if (result) {
          result.push(subarray);
        } else {
          Opal.yield1(block, subarray)
        }
        m = n - 1;
        counters[m]++;
        while (counters[m] === lengths[m]) {
          counters[m] = 0;
          if (--m < 0) break outer_loop;
          counters[m]++;
        }
      }

      return result || self;
    ;
    }, -1);
    
    $def(self, '$push', function $$push($a) {
      var $post_args, objects, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      objects = $post_args;;
      
      for (var i = 0, length = objects.length; i < length; i++) {
        self.push(objects[i]);
      }
    ;
      return self;
    }, -1);
    
    $def(self, '$rassoc', function $$rassoc(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        item = self[i];

        if (item.length && item[1] !== undefined) {
          if ((item[1])['$=='](object)) {
            return item;
          }
        }
      }

      return nil;
    
    }, 1);
    
    $def(self, '$reject', function $$reject() {
      var block = $$reject.$$p || nil, self = this;

      delete $$reject.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["reject"], function $$36(){var self = $$36.$$s == null ? this : $$36.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var result = [];

      for (var i = 0, length = self.length, value; i < length; i++) {
        value = block(self[i]);

        if (value === false || value === nil) {
          result.push(self[i]);
        }
      }
      return result;
    ;
    }, 0);
    
    $def(self, '$reject!', function $Array_reject$excl$37() {
      var block = $Array_reject$excl$37.$$p || nil, self = this, original = nil;

      delete $Array_reject$excl$37.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["reject!"], function $$38(){var self = $$38.$$s == null ? this : $$38.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      original = self.$length();
      $send(self, 'delete_if', [], block.$to_proc());
      if ($eqeq(self.$length(), original)) {
        return nil
      } else {
        return self
      };
    }, 0);
    
    $def(self, '$replace', function $$replace(other) {
      var self = this;

      
      other = ($eqeqeq($$$('Array'), other) ? (other.$to_a()) : (($coerce_to(other, $$$('Array'), 'to_ary')).$to_a()));
      
      self.splice(0, self.length);
      self.push.apply(self, other);
    ;
      return self;
    }, 1);
    
    $def(self, '$reverse', function $$reverse() {
      var self = this;

      return self.slice(0).reverse();
    }, 0);
    
    $def(self, '$reverse!', function $Array_reverse$excl$39() {
      var self = this;

      return self.reverse();
    }, 0);
    
    $def(self, '$reverse_each', function $$reverse_each() {
      var block = $$reverse_each.$$p || nil, self = this;

      delete $$reverse_each.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["reverse_each"], function $$40(){var self = $$40.$$s == null ? this : $$40.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      $send(self.$reverse(), 'each', [], block.$to_proc());
      return self;
    }, 0);
    
    $def(self, '$rindex', function $$rindex(object) {
      var block = $$rindex.$$p || nil, self = this;

      delete $$rindex.$$p;
      
      ;
      ;
      
      var i, value;

      if (object != null && block !== nil) {
        self.$warn("warning: given block not used")
      }

      if (object != null) {
        for (i = self.length - 1; i >= 0; i--) {
          if (i >= self.length) {
            break;
          }
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (i = self.length - 1; i >= 0; i--) {
          if (i >= self.length) {
            break;
          }

          value = block(self[i]);

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else if (object == null) {
        return self.$enum_for("rindex");
      }

      return nil;
    ;
    }, -1);
    
    $def(self, '$rotate', function $$rotate(n) {
      var self = this;

      
      
      if (n == null) n = 1;;
      
      var ary, idx, firstPart, lastPart;

      n = $coerce_to(n, $$$('Integer'), 'to_int')

      if (self.length === 1) {
        return self.slice();
      }
      if (self.length === 0) {
        return [];
      }

      ary = self.slice();
      idx = n % ary.length;

      firstPart = ary.slice(idx);
      lastPart = ary.slice(0, idx);
      return firstPart.concat(lastPart);
    ;
    }, -1);
    
    $def(self, '$rotate!', function $Array_rotate$excl$41(cnt) {
      var self = this, ary = nil;

      
      
      if (cnt == null) cnt = 1;;
      
      if (self.length === 0 || self.length === 1) {
        return self;
      }
      cnt = $coerce_to(cnt, $$$('Integer'), 'to_int');
    ;
      ary = self.$rotate(cnt);
      return self.$replace(ary);
    }, -1);
    (function($base, $super) {
      var self = $klass($base, $super, 'SampleRandom');

      var $proto = self.$$prototype;

      $proto.rng = nil;
      
      
      $def(self, '$initialize', $assign_ivar("rng"), 0);
      return $def(self, '$rand', function $$rand(size) {
        var self = this, random = nil;

        
        random = $coerce_to(self.rng.$rand(size), $$$('Integer'), 'to_int');
        if ($truthy(random < 0)) {
          $Kernel.$raise($$$('RangeError'), "random value must be >= 0")
        };
        if (!$truthy(random < size)) {
          $Kernel.$raise($$$('RangeError'), "random value must be less than Array size")
        };
        return random;
      }, 1);
    })(self, null);
    
    $def(self, '$sample', function $$sample(count, options) {
      var self = this, o = nil, rng = nil;

      
      ;
      ;
      if ($truthy(count === undefined)) {
        return self.$at($Kernel.$rand(self.length))
      };
      if ($truthy(options === undefined)) {
        if ($truthy((o = $Opal['$coerce_to?'](count, $$$('Hash'), "to_hash")))) {
          
          options = o;
          count = nil;
        } else {
          
          options = nil;
          count = $coerce_to(count, $$$('Integer'), 'to_int');
        }
      } else {
        
        count = $coerce_to(count, $$$('Integer'), 'to_int');
        options = $coerce_to(options, $$$('Hash'), 'to_hash');
      };
      if (($truthy(count) && ($truthy(count < 0)))) {
        $Kernel.$raise($$$('ArgumentError'), "count must be greater than 0")
      };
      if ($truthy(options)) {
        rng = options['$[]']("random")
      };
      rng = (($truthy(rng) && ($truthy(rng['$respond_to?']("rand")))) ? ($$('SampleRandom').$new(rng)) : ($Kernel));
      if (!$truthy(count)) {
        return self[rng.$rand(self.length)]
      };
      

      var abandon, spin, result, i, j, k, targetIndex, oldValue;

      if (count > self.length) {
        count = self.length;
      }

      switch (count) {
        case 0:
          return [];
          break;
        case 1:
          return [self[rng.$rand(self.length)]];
          break;
        case 2:
          i = rng.$rand(self.length);
          j = rng.$rand(self.length);
          if (i === j) {
            j = i === 0 ? i + 1 : i - 1;
          }
          return [self[i], self[j]];
          break;
        default:
          if (self.length / count > 3) {
            abandon = false;
            spin = 0;

            result = $$('Array').$new(count);
            i = 1;

            result[0] = rng.$rand(self.length);
            while (i < count) {
              k = rng.$rand(self.length);
              j = 0;

              while (j < i) {
                while (k === result[j]) {
                  spin++;
                  if (spin > 100) {
                    abandon = true;
                    break;
                  }
                  k = rng.$rand(self.length);
                }
                if (abandon) { break; }

                j++;
              }

              if (abandon) { break; }

              result[i] = k;

              i++;
            }

            if (!abandon) {
              i = 0;
              while (i < count) {
                result[i] = self[result[i]];
                i++;
              }

              return result;
            }
          }

          result = self.slice();

          for (var c = 0; c < count; c++) {
            targetIndex = rng.$rand(self.length);
            oldValue = result[c];
            result[c] = result[targetIndex];
            result[targetIndex] = oldValue;
          }

          return count === self.length ? result : (result)['$[]'](0, count);
      }
    ;
    }, -1);
    
    $def(self, '$select', function $$select() {
      var block = $$select.$$p || nil, self = this;

      delete $$select.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["select"], function $$42(){var self = $$42.$$s == null ? this : $$42.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        value = $yield1(block, item);

        if ($truthy(value)) {
          result.push(item);
        }
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$select!', function $Array_select$excl$43() {
      var block = $Array_select$excl$43.$$p || nil, self = this;

      delete $Array_select$excl$43.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["select!"], function $$44(){var self = $$44.$$s == null ? this : $$44.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var original = self.length;
      $send(self, 'keep_if', [], block.$to_proc());
      return self.length === original ? nil : self;
    ;
    }, 0);
    
    $def(self, '$shift', function $$shift(count) {
      var self = this;

      
      ;
      if ($truthy(count === undefined)) {
        
        if ($truthy(self.length === 0)) {
          return nil
        };
        return shiftNoArg(self);
      };
      count = $coerce_to(count, $$$('Integer'), 'to_int');
      if ($truthy(count < 0)) {
        $Kernel.$raise($$$('ArgumentError'), "negative array size")
      };
      if ($truthy(self.length === 0)) {
        return []
      };
      return self.splice(0, count);;
    }, -1);
    
    $def(self, '$shuffle', function $$shuffle(rng) {
      var self = this;

      
      ;
      return self.$dup().$to_a()['$shuffle!'](rng);
    }, -1);
    
    $def(self, '$shuffle!', function $Array_shuffle$excl$45(rng) {
      var self = this;

      
      ;
      
      var randgen, i = self.length, j, tmp;

      if (rng !== undefined) {
        rng = $Opal['$coerce_to?'](rng, $$$('Hash'), "to_hash");

        if (rng !== nil) {
          rng = rng['$[]']("random");

          if (rng !== nil && rng['$respond_to?']("rand")) {
            randgen = rng;
          }
        }
      }

      while (i) {
        if (randgen) {
          j = randgen.$rand(i).$to_int();

          if (j < 0) {
            $Kernel.$raise($$$('RangeError'), "random number too small " + (j))
          }

          if (j >= i) {
            $Kernel.$raise($$$('RangeError'), "random number too big " + (j))
          }
        }
        else {
          j = self.$rand(i);
        }

        tmp = self[--i];
        self[i] = self[j];
        self[j] = tmp;
      }

      return self;
    ;
    }, -1);
    
    $def(self, '$slice!', function $Array_slice$excl$46(index, length) {
      var self = this, result = nil, range = nil, range_start = nil, range_end = nil, start = nil;

      
      ;
      result = nil;
      if ($truthy(length === undefined)) {
        if ($eqeqeq($$$('Range'), index)) {
          
          range = index;
          result = self['$[]'](range);
          range_start = range.begin === nil ? 0 : $coerce_to(range.begin, $$$('Integer'), 'to_int');
          range_end = range.end === nil ? -1 : $coerce_to(range.end, $$$('Integer'), 'to_int');
          
          if (range_start < 0) {
            range_start += self.length;
          }

          if (range_end < 0) {
            range_end += self.length;
          } else if (range_end >= self.length) {
            range_end = self.length - 1;
            if (range.excl) {
              range_end += 1;
            }
          }

          var range_length = range_end - range_start;
          if (range.excl && range.end !== nil) {
            range_end -= 1;
          } else {
            range_length += 1;
          }

          if (range_start < self.length && range_start >= 0 && range_end < self.length && range_end >= 0 && range_length > 0) {
            self.splice(range_start, range_length);
          }
        ;
        } else {
          
          start = $coerce_to(index, $$$('Integer'), 'to_int');
          
          if (start < 0) {
            start += self.length;
          }

          if (start < 0 || start >= self.length) {
            return nil;
          }

          result = self[start];

          if (start === 0) {
            self.shift();
          } else {
            self.splice(start, 1);
          }
        ;
        }
      } else {
        
        start = $coerce_to(index, $$$('Integer'), 'to_int');
        length = $coerce_to(length, $$$('Integer'), 'to_int');
        
        if (length < 0) {
          return nil;
        }

        var end = start + length;

        result = self['$[]'](start, length);

        if (start < 0) {
          start += self.length;
        }

        if (start + length > self.length) {
          length = self.length - start;
        }

        if (start < self.length && start >= 0) {
          self.splice(start, length);
        }
      ;
      };
      return result;
    }, -2);
    
    $def(self, '$sort', function $$sort() {
      var block = $$sort.$$p || nil, self = this;

      delete $$sort.$$p;
      
      ;
      if (!$truthy(self.length > 1)) {
        return self
      };
      
      if (block === nil) {
        block = function(a, b) {
          return (a)['$<=>'](b);
        };
      }

      return self.slice().sort(function(x, y) {
        var ret = block(x, y);

        if (ret === nil) {
          $Kernel.$raise($$$('ArgumentError'), "comparison of " + ((x).$inspect()) + " with " + ((y).$inspect()) + " failed");
        }

        return $rb_gt(ret, 0) ? 1 : ($rb_lt(ret, 0) ? -1 : 0);
      });
    ;
    }, 0);
    
    $def(self, '$sort!', function $Array_sort$excl$47() {
      var block = $Array_sort$excl$47.$$p || nil, self = this;

      delete $Array_sort$excl$47.$$p;
      
      ;
      
      var result;

      if ((block !== nil)) {
        result = $send((self.slice()), 'sort', [], block.$to_proc());
      }
      else {
        result = (self.slice()).$sort();
      }

      self.length = 0;
      for(var i = 0, length = result.length; i < length; i++) {
        self.push(result[i]);
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$sort_by!', function $Array_sort_by$excl$48() {
      var block = $Array_sort_by$excl$48.$$p || nil, self = this;

      delete $Array_sort_by$excl$48.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["sort_by!"], function $$49(){var self = $$49.$$s == null ? this : $$49.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      return self.$replace($send(self, 'sort_by', [], block.$to_proc()));
    }, 0);
    
    $def(self, '$take', function $$take(count) {
      var self = this;

      
      if (count < 0) {
        $Kernel.$raise($$$('ArgumentError'));
      }

      return self.slice(0, count);
    
    }, 1);
    
    $def(self, '$take_while', function $$take_while() {
      var block = $$take_while.$$p || nil, self = this;

      delete $$take_while.$$p;
      
      ;
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        value = block(item);

        if (value === false || value === nil) {
          return result;
        }

        result.push(item);
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$to_a', function $$to_a() {
      var self = this;

      
      if (self.$$class === Opal.Array) {
        return self;
      }
      else {
        return Opal.Array.$new(self);
      }
    
    }, 0);
    
    $def(self, '$to_ary', $return_self, 0);
    
    $def(self, '$to_h', function $$to_h() {
      var block = $$to_h.$$p || nil, self = this, array = nil;

      delete $$to_h.$$p;
      
      ;
      array = self;
      if ((block !== nil)) {
        array = $send(array, 'map', [], block.$to_proc())
      };
      
      var i, len = array.length, ary, key, val, hash = $hash2([], {});

      for (i = 0; i < len; i++) {
        ary = $Opal['$coerce_to?'](array[i], $$$('Array'), "to_ary");
        if (!ary.$$is_array) {
          $Kernel.$raise($$$('TypeError'), "wrong element type " + ((ary).$class()) + " at " + (i) + " (expected array)")
        }
        if (ary.length !== 2) {
          $Kernel.$raise($$$('ArgumentError'), "wrong array length at " + (i) + " (expected 2, was " + ((ary).$length()) + ")")
        }
        key = ary[0];
        val = ary[1];
        $hash_put(hash, key, val);
      }

      return hash;
    ;
    }, 0);
    
    $def(self, '$transpose', function $$transpose() {
      var self = this, result = nil, max = nil;

      
      if ($truthy(self['$empty?']())) {
        return []
      };
      result = [];
      max = nil;
      $send(self, 'each', [], function $$50(row){var $ret_or_1 = nil;

        
        
        if (row == null) row = nil;;
        row = ($eqeqeq($$$('Array'), row) ? (row.$to_a()) : (($coerce_to(row, $$$('Array'), 'to_ary')).$to_a()));
        max = ($truthy(($ret_or_1 = max)) ? ($ret_or_1) : (row.length));
        if ($neqeq(row.length, max)) {
          $Kernel.$raise($$$('IndexError'), "element size differs (" + (row.length) + " should be " + (max) + ")")
        };
        return $send((row.length), 'times', [], function $$51(i){var $a, entry = nil;

          
          
          if (i == null) i = nil;;
          entry = ($truthy(($ret_or_1 = result['$[]'](i))) ? ($ret_or_1) : (($a = [i, []], $send(result, '[]=', $a), $a[$a.length - 1])));
          return entry['$<<'](row.$at(i));}, 1);}, 1);
      return result;
    }, 0);
    
    $def(self, '$union', function $$union($a) {
      var $post_args, arrays, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      arrays = $post_args;;
      return $send(arrays, 'reduce', [self.$uniq()], function $$52(a, b){
        
        
        if (a == null) a = nil;;
        
        if (b == null) b = nil;;
        return a['$|'](b);}, 2);
    }, -1);
    
    $def(self, '$uniq', function $$uniq() {
      var block = $$uniq.$$p || nil, self = this;

      delete $$uniq.$$p;
      
      ;
      
      var hash = $hash2([], {}), i, length, item, key;

      if (block === nil) {
        for (i = 0, length = self.length; i < length; i++) {
          item = self[i];
          if ($hash_get(hash, item) === undefined) {
            $hash_put(hash, item, item);
          }
        }
      }
      else {
        for (i = 0, length = self.length; i < length; i++) {
          item = self[i];
          key = $yield1(block, item);
          if ($hash_get(hash, key) === undefined) {
            $hash_put(hash, key, item);
          }
        }
      }

      return (hash).$values();
    ;
    }, 0);
    
    $def(self, '$uniq!', function $Array_uniq$excl$53() {
      var block = $Array_uniq$excl$53.$$p || nil, self = this;

      delete $Array_uniq$excl$53.$$p;
      
      ;
      
      var original_length = self.length, hash = $hash2([], {}), i, length, item, key;

      for (i = 0, length = original_length; i < length; i++) {
        item = self[i];
        key = (block === nil ? item : $yield1(block, item));

        if ($hash_get(hash, key) === undefined) {
          $hash_put(hash, key, item);
          continue;
        }

        self.splice(i, 1);
        length--;
        i--;
      }

      return self.length === original_length ? nil : self;
    ;
    }, 0);
    
    $def(self, '$unshift', function $$unshift($a) {
      var $post_args, objects, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      objects = $post_args;;
      
      var selfLength = self.length
      var objectsLength = objects.length
      if (objectsLength == 0) return self;
      var index = selfLength - objectsLength
      for (var i = 0; i < objectsLength; i++) {
        self.push(self[index + i])
      }
      var len = selfLength - 1
      while (len - objectsLength >= 0) {
        self[len] = self[len - objectsLength]
        len--
      }
      for (var j = 0; j < objectsLength; j++) {
        self[j] = objects[j]
      }
      return self;
    ;
    }, -1);
    
    $def(self, '$values_at', function $$values_at($a) {
      var $post_args, args, self = this, out = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      out = [];
      $send(args, 'each', [], function $$54(elem){var self = $$54.$$s == null ? this : $$54.$$s, finish = nil, start = nil, i = nil;

        
        
        if (elem == null) elem = nil;;
        if ($truthy(elem['$is_a?']($$$('Range')))) {
          
          finish = elem.$end() === nil ? -1 : $coerce_to(elem.$end(), $$$('Integer'), 'to_int');
          start = elem.$begin() === nil ? 0 : $coerce_to(elem.$begin(), $$$('Integer'), 'to_int');
          
          if (start < 0) {
            start = start + self.length;
            return nil;;
          }
        ;
          
          if (finish < 0) {
            finish = finish + self.length;
          }
          if (elem['$exclude_end?']() && elem.$end() !== nil) {
            finish--;
          }
          if (finish < start) {
            return nil;;
          }
        ;
          return $send(start, 'upto', [finish], function $$55(i){var self = $$55.$$s == null ? this : $$55.$$s;

            
            
            if (i == null) i = nil;;
            return out['$<<'](self.$at(i));}, {$$arity: 1, $$s: self});
        } else {
          
          i = $coerce_to(elem, $$$('Integer'), 'to_int');
          return out['$<<'](self.$at(i));
        };}, {$$arity: 1, $$s: self});
      return out;
    }, -1);
    
    $def(self, '$zip', function $$zip($a) {
      var block = $$zip.$$p || nil, $post_args, others, self = this, $ret_or_1 = nil;

      delete $$zip.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      others = $post_args;;
      
      var result = [], size = self.length, part, o, i, j, jj;

      for (j = 0, jj = others.length; j < jj; j++) {
        o = others[j];
        if (o.$$is_array) {
          continue;
        }
        if (o.$$is_range || o.$$is_enumerator) {
          others[j] = o.$take(size);
          continue;
        }
        others[j] = ($truthy(($ret_or_1 = $Opal['$coerce_to?'](o, $$$('Array'), "to_ary"))) ? ($ret_or_1) : ($Opal['$coerce_to!'](o, $$$('Enumerator'), "to_enum", "each"))).$to_a();
      }

      for (i = 0; i < size; i++) {
        part = [self[i]];

        for (j = 0, jj = others.length; j < jj; j++) {
          o = others[j][i];

          if (o == null) {
            o = nil;
          }

          part[j + 1] = o;
        }

        result[i] = part;
      }

      if (block !== nil) {
        for (i = 0; i < size; i++) {
          Opal.yield1(block, result[i]);
        }

        return nil;
      }

      return result;
    ;
    }, -1);
    $defs(self, '$inherited', function $$inherited(klass) {
      
      
      klass.$$prototype.$to_a = function() {
        return this.slice(0, this.length);
      }
    
    }, 1);
    
    $def(self, '$instance_variables', function $$instance_variables() {
      var $yield = $$instance_variables.$$p || nil, self = this;

      delete $$instance_variables.$$p;
      return $send($send2(self, $find_super(self, 'instance_variables', $$instance_variables, false, true), 'instance_variables', [], $yield), 'reject', [], function $$56(ivar){var $ret_or_1 = nil;

        
        
        if (ivar == null) ivar = nil;;
        if ($truthy(($ret_or_1 = /^@\d+$/.test(ivar)))) {
          return $ret_or_1
        } else {
          return ivar['$==']("@length")
        };}, 1)
    }, 0);
    
    $def(self, '$pack', function $$pack($a) {
      var $post_args, args;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return $Kernel.$raise("To use Array#pack, you must first require 'corelib/array/pack'.");
    }, -1);
    $alias(self, "append", "push");
    $alias(self, "filter", "select");
    $alias(self, "filter!", "select!");
    $alias(self, "map", "collect");
    $alias(self, "map!", "collect!");
    $alias(self, "prepend", "unshift");
    $alias(self, "size", "length");
    $alias(self, "slice", "[]");
    $alias(self, "to_s", "inspect");
    $Opal.$pristine(self.$singleton_class(), "allocate");
    return $Opal.$pristine(self, "copy_instance_variables", "initialize_dup");
  })('::', Array, $nesting);
};

Opal.modules["corelib/hash"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $yield1 = Opal.yield1, $hash = Opal.hash, $hash_init = Opal.hash_init, $hash_get = Opal.hash_get, $hash_put = Opal.hash_put, $hash_delete = Opal.hash_delete, $klass = Opal.klass, $Opal = Opal.Opal, $Kernel = Opal.Kernel, $defs = Opal.defs, $def = Opal.def, $send = Opal.send, $rb_ge = Opal.rb_ge, $rb_gt = Opal.rb_gt, $hash2 = Opal.hash2, $truthy = Opal.truthy, $to_a = Opal.to_a, $return_self = Opal.return_self, $alias = Opal.alias;

  Opal.add_stubs('require,include,coerce_to?,[],merge!,allocate,raise,coerce_to!,each,fetch,>=,>,==,compare_by_identity,lambda?,abs,arity,enum_for,size,respond_to?,class,dig,except!,dup,delete,new,inspect,map,to_proc,flatten,eql?,default,default_proc,default_proc=,default=,to_h,proc,clone,select,select!,has_key?,indexes,index,length,[]=,has_value?');
  
  self.$require("corelib/enumerable");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Hash');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    self.$include($$$('Enumerable'));
    self.$$prototype.$$is_hash = true;
    $defs(self, '$[]', function $Hash_$$$1($a) {
      var $post_args, argv, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      argv = $post_args;;
      
      var hash, argc = argv.length, i;

      if (argc === 1) {
        hash = $Opal['$coerce_to?'](argv['$[]'](0), $$$('Hash'), "to_hash");
        if (hash !== nil) {
          return self.$allocate()['$merge!'](hash);
        }

        argv = $Opal['$coerce_to?'](argv['$[]'](0), $$$('Array'), "to_ary");
        if (argv === nil) {
          $Kernel.$raise($$$('ArgumentError'), "odd number of arguments for Hash")
        }

        argc = argv.length;
        hash = self.$allocate();

        for (i = 0; i < argc; i++) {
          if (!argv[i].$$is_array) continue;
          switch(argv[i].length) {
          case 1:
            hash.$store(argv[i][0], nil);
            break;
          case 2:
            hash.$store(argv[i][0], argv[i][1]);
            break;
          default:
            $Kernel.$raise($$$('ArgumentError'), "invalid number of elements (" + (argv[i].length) + " for 1..2)")
          }
        }

        return hash;
      }

      if (argc % 2 !== 0) {
        $Kernel.$raise($$$('ArgumentError'), "odd number of arguments for Hash")
      }

      hash = self.$allocate();

      for (i = 0; i < argc; i += 2) {
        hash.$store(argv[i], argv[i + 1]);
      }

      return hash;
    ;
    }, -1);
    $defs(self, '$allocate', function $$allocate() {
      var self = this;

      
      var hash = new self.$$constructor();

      $hash_init(hash);

      hash.$$none = nil;
      hash.$$proc = nil;

      return hash;
    
    }, 0);
    $defs(self, '$try_convert', function $$try_convert(obj) {
      
      return $Opal['$coerce_to?'](obj, $$$('Hash'), "to_hash")
    }, 1);
    
    $def(self, '$initialize', function $$initialize(defaults) {
      var block = $$initialize.$$p || nil, self = this;

      delete $$initialize.$$p;
      
      ;
      ;
      
      if (defaults !== undefined && block !== nil) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (1 for 0)")
      }
      self.$$none = (defaults === undefined ? nil : defaults);
      self.$$proc = block;

      return self;
    ;
    }, -1);
    
    $def(self, '$==', function $Hash_$eq_eq$2(other) {
      var self = this;

      
      if (self === other) {
        return true;
      }

      if (!other.$$is_hash) {
        return false;
      }

      if (self.$$keys.length !== other.$$keys.length) {
        return false;
      }

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, other_value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
          other_value = other.$$smap[key];
        } else {
          value = key.value;
          other_value = $hash_get(other, key.key);
        }

        if (other_value === undefined || !value['$eql?'](other_value)) {
          return false;
        }
      }

      return true;
    
    }, 1);
    
    $def(self, '$>=', function $Hash_$gt_eq$3(other) {
      var self = this, result = nil;

      
      other = $Opal['$coerce_to!'](other, $$$('Hash'), "to_hash");
      
      if (self.$$keys.length < other.$$keys.length) {
        return false
      }
    ;
      result = true;
      $send(other, 'each', [], function $$4(other_key, other_val){var self = $$4.$$s == null ? this : $$4.$$s, val = nil;

        
        
        if (other_key == null) other_key = nil;;
        
        if (other_val == null) other_val = nil;;
        val = self.$fetch(other_key, null);
        
        if (val == null || val !== other_val) {
          result = false;
          return;
        }
      ;}, {$$arity: 2, $$s: self});
      return result;
    }, 1);
    
    $def(self, '$>', function $Hash_$gt$5(other) {
      var self = this;

      
      other = $Opal['$coerce_to!'](other, $$$('Hash'), "to_hash");
      
      if (self.$$keys.length <= other.$$keys.length) {
        return false
      }
    ;
      return $rb_ge(self, other);
    }, 1);
    
    $def(self, '$<', function $Hash_$lt$6(other) {
      var self = this;

      
      other = $Opal['$coerce_to!'](other, $$$('Hash'), "to_hash");
      return $rb_gt(other, self);
    }, 1);
    
    $def(self, '$<=', function $Hash_$lt_eq$7(other) {
      var self = this;

      
      other = $Opal['$coerce_to!'](other, $$$('Hash'), "to_hash");
      return $rb_ge(other, self);
    }, 1);
    
    $def(self, '$[]', function $Hash_$$$8(key) {
      var self = this;

      
      var value = $hash_get(self, key);

      if (value !== undefined) {
        return value;
      }

      return self.$default(key);
    
    }, 1);
    
    $def(self, '$[]=', function $Hash_$$$eq$9(key, value) {
      var self = this;

      
      $hash_put(self, key, value);
      return value;
    
    }, 2);
    
    $def(self, '$assoc', function $$assoc(object) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          if ((key)['$=='](object)) {
            return [key, self.$$smap[key]];
          }
        } else {
          if ((key.key)['$=='](object)) {
            return [key.key, key.value];
          }
        }
      }

      return nil;
    
    }, 1);
    
    $def(self, '$clear', function $$clear() {
      var self = this;

      
      $hash_init(self);
      return self;
    
    }, 0);
    
    $def(self, '$clone', function $$clone() {
      var self = this;

      
      var hash = new self.$$class();

      $hash_init(hash);
      Opal.hash_clone(self, hash);

      return hash;
    
    }, 0);
    
    $def(self, '$compact', function $$compact() {
      var self = this;

      
      var hash = $hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        if (value !== nil) {
          $hash_put(hash, key, value);
        }
      }

      return hash;
    
    }, 0);
    
    $def(self, '$compact!', function $Hash_compact$excl$10() {
      var self = this;

      
      var changes_were_made = false;

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        if (value === nil) {
          if ($hash_delete(self, key) !== undefined) {
            changes_were_made = true;
            length--;
            i--;
          }
        }
      }

      return changes_were_made ? self : nil;
    
    }, 0);
    
    $def(self, '$compare_by_identity', function $$compare_by_identity() {
      var self = this;

      
      var i, ii, key, keys = self.$$keys, identity_hash;

      if (self.$$by_identity) return self;
      if (self.$$keys.length === 0) {
        self.$$by_identity = true
        return self;
      }

      identity_hash = $hash2([], {}).$compare_by_identity();
      for(i = 0, ii = keys.length; i < ii; i++) {
        key = keys[i];
        if (!key.$$is_string) key = key.key;
        $hash_put(identity_hash, key, $hash_get(self, key));
      }

      self.$$by_identity = true;
      self.$$map = identity_hash.$$map;
      self.$$smap = identity_hash.$$smap;
      return self;
    
    }, 0);
    
    $def(self, '$compare_by_identity?', function $Hash_compare_by_identity$ques$11() {
      var self = this;

      return self.$$by_identity === true;
    }, 0);
    
    $def(self, '$default', function $Hash_default$12(key) {
      var self = this;

      
      ;
      
      if (key !== undefined && self.$$proc !== nil && self.$$proc !== undefined) {
        return self.$$proc.$call(self, key);
      }
      if (self.$$none === undefined) {
        return nil;
      }
      return self.$$none;
    ;
    }, -1);
    
    $def(self, '$default=', function $Hash_default$eq$13(object) {
      var self = this;

      
      self.$$proc = nil;
      self.$$none = object;

      return object;
    
    }, 1);
    
    $def(self, '$default_proc', function $$default_proc() {
      var self = this;

      
      if (self.$$proc !== undefined) {
        return self.$$proc;
      }
      return nil;
    
    }, 0);
    
    $def(self, '$default_proc=', function $Hash_default_proc$eq$14(default_proc) {
      var self = this;

      
      var proc = default_proc;

      if (proc !== nil) {
        proc = $Opal['$coerce_to!'](proc, $$$('Proc'), "to_proc");

        if ((proc)['$lambda?']() && (proc).$arity().$abs() !== 2) {
          $Kernel.$raise($$$('TypeError'), "default_proc takes two arguments");
        }
      }

      self.$$none = nil;
      self.$$proc = proc;

      return default_proc;
    
    }, 1);
    
    $def(self, '$delete', function $Hash_delete$15(key) {
      var block = $Hash_delete$15.$$p || nil, self = this;

      delete $Hash_delete$15.$$p;
      
      ;
      
      var value = $hash_delete(self, key);

      if (value !== undefined) {
        return value;
      }

      if (block !== nil) {
        return Opal.yield1(block, key);
      }

      return nil;
    ;
    }, 1);
    
    $def(self, '$delete_if', function $$delete_if() {
      var block = $$delete_if.$$p || nil, self = this;

      delete $$delete_if.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["delete_if"], function $$16(){var self = $$16.$$s == null ? this : $$16.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj !== false && obj !== nil) {
          if ($hash_delete(self, key) !== undefined) {
            length--;
            i--;
          }
        }
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$dig', function $$dig(key, $a) {
      var $post_args, keys, self = this, item = nil;

      
      
      $post_args = Opal.slice.call(arguments, 1);
      
      keys = $post_args;;
      item = self['$[]'](key);
      
      if (item === nil || keys.length === 0) {
        return item;
      }
    ;
      if (!$truthy(item['$respond_to?']("dig"))) {
        $Kernel.$raise($$$('TypeError'), "" + (item.$class()) + " does not have #dig method")
      };
      return $send(item, 'dig', $to_a(keys));
    }, -2);
    
    $def(self, '$each', function $$each() {
      var block = $$each.$$p || nil, self = this;

      delete $$each.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["each"], function $$17(){var self = $$17.$$s == null ? this : $$17.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, keys = self.$$keys.slice(), length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        $yield1(block, [key, value]);
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$each_key', function $$each_key() {
      var block = $$each_key.$$p || nil, self = this;

      delete $$each_key.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["each_key"], function $$18(){var self = $$18.$$s == null ? this : $$18.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, keys = self.$$keys.slice(), length = keys.length, key; i < length; i++) {
        key = keys[i];

        block(key.$$is_string ? key : key.key);
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$each_value', function $$each_value() {
      var block = $$each_value.$$p || nil, self = this;

      delete $$each_value.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["each_value"], function $$19(){var self = $$19.$$s == null ? this : $$19.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, keys = self.$$keys.slice(), length = keys.length, key; i < length; i++) {
        key = keys[i];

        block(key.$$is_string ? self.$$smap[key] : key.value);
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$empty?', function $Hash_empty$ques$20() {
      var self = this;

      return self.$$keys.length === 0;
    }, 0);
    
    $def(self, '$except', function $$except($a) {
      var $post_args, keys, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      keys = $post_args;;
      return $send(self.$dup(), 'except!', $to_a(keys));
    }, -1);
    
    $def(self, '$except!', function $Hash_except$excl$21($a) {
      var $post_args, keys, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      keys = $post_args;;
      $send(keys, 'each', [], function $$22(key){var self = $$22.$$s == null ? this : $$22.$$s;

        
        
        if (key == null) key = nil;;
        return self.$delete(key);}, {$$arity: 1, $$s: self});
      return self;
    }, -1);
    
    $def(self, '$fetch', function $$fetch(key, defaults) {
      var block = $$fetch.$$p || nil, self = this;

      delete $$fetch.$$p;
      
      ;
      ;
      
      var value = $hash_get(self, key);

      if (value !== undefined) {
        return value;
      }

      if (block !== nil) {
        return block(key);
      }

      if (defaults !== undefined) {
        return defaults;
      }
    ;
      return $Kernel.$raise($$$('KeyError').$new("key not found: " + (key.$inspect()), $hash2(["key", "receiver"], {"key": key, "receiver": self})));
    }, -2);
    
    $def(self, '$fetch_values', function $$fetch_values($a) {
      var block = $$fetch_values.$$p || nil, $post_args, keys, self = this;

      delete $$fetch_values.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      keys = $post_args;;
      return $send(keys, 'map', [], function $$23(key){var self = $$23.$$s == null ? this : $$23.$$s;

        
        
        if (key == null) key = nil;;
        return $send(self, 'fetch', [key], block.$to_proc());}, {$$arity: 1, $$s: self});
    }, -1);
    
    $def(self, '$flatten', function $$flatten(level) {
      var self = this;

      
      
      if (level == null) level = 1;;
      level = $Opal['$coerce_to!'](level, $$$('Integer'), "to_int");
      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        result.push(key);

        if (value.$$is_array) {
          if (level === 1) {
            result.push(value);
            continue;
          }

          result = result.concat((value).$flatten(level - 2));
          continue;
        }

        result.push(value);
      }

      return result;
    ;
    }, -1);
    
    $def(self, '$has_key?', function $Hash_has_key$ques$24(key) {
      var self = this;

      return $hash_get(self, key) !== undefined;
    }, 1);
    
    $def(self, '$has_value?', function $Hash_has_value$ques$25(value) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (((key.$$is_string ? self.$$smap[key] : key.value))['$=='](value)) {
          return true;
        }
      }

      return false;
    
    }, 1);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      
      var top = (Opal.hash_ids === undefined),
          hash_id = self.$object_id(),
          result = ['Hash'],
          key, item;

      try {
        if (top) {
          Opal.hash_ids = Object.create(null);
        }

        if (Opal[hash_id]) {
          return 'self';
        }

        for (key in Opal.hash_ids) {
          item = Opal.hash_ids[key];
          if (self['$eql?'](item)) {
            return 'self';
          }
        }

        Opal.hash_ids[hash_id] = self;

        for (var i = 0, keys = self.$$keys, length = keys.length; i < length; i++) {
          key = keys[i];

          if (key.$$is_string) {
            result.push([key, self.$$smap[key].$hash()]);
          } else {
            result.push([key.key_hash, key.value.$hash()]);
          }
        }

        return result.sort().join();

      } finally {
        if (top) {
          Opal.hash_ids = undefined;
        }
      }
    
    }, 0);
    
    $def(self, '$index', function $$index(object) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        if ((value)['$=='](object)) {
          return key;
        }
      }

      return nil;
    
    }, 1);
    
    $def(self, '$indexes', function $$indexes($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var result = [];

      for (var i = 0, length = args.length, key, value; i < length; i++) {
        key = args[i];
        value = $hash_get(self, key);

        if (value === undefined) {
          result.push(self.$default());
          continue;
        }

        result.push(value);
      }

      return result;
    ;
    }, -1);
    var inspect_ids;
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      
      
      var top = (inspect_ids === undefined),
          hash_id = self.$object_id(),
          result = [];
    ;
      
      return (function() { try {
      
      
        if (top) {
          inspect_ids = {};
        }

        if (inspect_ids.hasOwnProperty(hash_id)) {
          return '{...}';
        }

        inspect_ids[hash_id] = true;

        for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
          key = keys[i];

          if (key.$$is_string) {
            value = self.$$smap[key];
          } else {
            value = key.value;
            key = key.key;
          }

          key = $$('Opal').$inspect(key)
          value = $$('Opal').$inspect(value)

          result.push(key + '=>' + value);
        }

        return '{' + result.join(', ') + '}';
      ;
      return nil;
      } finally {
        if (top) inspect_ids = undefined
      }; })();;
    }, 0);
    
    $def(self, '$invert', function $$invert() {
      var self = this;

      
      var hash = $hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        $hash_put(hash, value, key);
      }

      return hash;
    
    }, 0);
    
    $def(self, '$keep_if', function $$keep_if() {
      var block = $$keep_if.$$p || nil, self = this;

      delete $$keep_if.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["keep_if"], function $$26(){var self = $$26.$$s == null ? this : $$26.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj === false || obj === nil) {
          if ($hash_delete(self, key) !== undefined) {
            length--;
            i--;
          }
        }
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$keys', function $$keys() {
      var self = this;

      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          result.push(key);
        } else {
          result.push(key.key);
        }
      }

      return result;
    
    }, 0);
    
    $def(self, '$length', function $$length() {
      var self = this;

      return self.$$keys.length;
    }, 0);
    
    $def(self, '$merge', function $$merge($a) {
      var block = $$merge.$$p || nil, $post_args, others, self = this;

      delete $$merge.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      others = $post_args;;
      return $send(self.$dup(), 'merge!', $to_a(others), block.$to_proc());
    }, -1);
    
    $def(self, '$merge!', function $Hash_merge$excl$27($a) {
      var block = $Hash_merge$excl$27.$$p || nil, $post_args, others, self = this;

      delete $Hash_merge$excl$27.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      others = $post_args;;
      
      var i, j, other, other_keys, length, key, value, other_value;
      for (i = 0; i < others.length; ++i) {
        other = $Opal['$coerce_to!'](others[i], $$$('Hash'), "to_hash");
        other_keys = other.$$keys, length = other_keys.length;

        if (block === nil) {
          for (j = 0; j < length; j++) {
            key = other_keys[j];

            if (key.$$is_string) {
              other_value = other.$$smap[key];
            } else {
              other_value = key.value;
              key = key.key;
            }

            $hash_put(self, key, other_value);
          }
        } else {
          for (j = 0; j < length; j++) {
            key = other_keys[j];

            if (key.$$is_string) {
              other_value = other.$$smap[key];
            } else {
              other_value = key.value;
              key = key.key;
            }

            value = $hash_get(self, key);

            if (value === undefined) {
              $hash_put(self, key, other_value);
              continue;
            }

            $hash_put(self, key, block(key, value, other_value));
          }
        }
      }

      return self;
    ;
    }, -1);
    
    $def(self, '$rassoc', function $$rassoc(object) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        if ((value)['$=='](object)) {
          return [key, value];
        }
      }

      return nil;
    
    }, 1);
    
    $def(self, '$rehash', function $$rehash() {
      var self = this;

      
      Opal.hash_rehash(self);
      return self;
    
    }, 0);
    
    $def(self, '$reject', function $$reject() {
      var block = $$reject.$$p || nil, self = this;

      delete $$reject.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["reject"], function $$28(){var self = $$28.$$s == null ? this : $$28.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var hash = $hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj === false || obj === nil) {
          $hash_put(hash, key, value);
        }
      }

      return hash;
    ;
    }, 0);
    
    $def(self, '$reject!', function $Hash_reject$excl$29() {
      var block = $Hash_reject$excl$29.$$p || nil, self = this;

      delete $Hash_reject$excl$29.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["reject!"], function $$30(){var self = $$30.$$s == null ? this : $$30.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var changes_were_made = false;

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj !== false && obj !== nil) {
          if ($hash_delete(self, key) !== undefined) {
            changes_were_made = true;
            length--;
            i--;
          }
        }
      }

      return changes_were_made ? self : nil;
    ;
    }, 0);
    
    $def(self, '$replace', function $$replace(other) {
      var self = this;

      
      other = $Opal['$coerce_to!'](other, $$$('Hash'), "to_hash");
      
      $hash_init(self);

      for (var i = 0, other_keys = other.$$keys, length = other_keys.length, key, value, other_value; i < length; i++) {
        key = other_keys[i];

        if (key.$$is_string) {
          other_value = other.$$smap[key];
        } else {
          other_value = key.value;
          key = key.key;
        }

        $hash_put(self, key, other_value);
      }
    ;
      if ($truthy(other.$default_proc())) {
        self['$default_proc='](other.$default_proc())
      } else {
        self['$default='](other.$default())
      };
      return self;
    }, 1);
    
    $def(self, '$select', function $$select() {
      var block = $$select.$$p || nil, self = this;

      delete $$select.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["select"], function $$31(){var self = $$31.$$s == null ? this : $$31.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var hash = $hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj !== false && obj !== nil) {
          $hash_put(hash, key, value);
        }
      }

      return hash;
    ;
    }, 0);
    
    $def(self, '$select!', function $Hash_select$excl$32() {
      var block = $Hash_select$excl$32.$$p || nil, self = this;

      delete $Hash_select$excl$32.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["select!"], function $$33(){var self = $$33.$$s == null ? this : $$33.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var result = nil;

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj === false || obj === nil) {
          if ($hash_delete(self, key) !== undefined) {
            length--;
            i--;
          }
          result = self;
        }
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$shift', function $$shift() {
      var self = this;

      
      var keys = self.$$keys,
          key;

      if (keys.length > 0) {
        key = keys[0];

        key = key.$$is_string ? key : key.key;

        return [key, $hash_delete(self, key)];
      }

      return self.$default(nil);
    
    }, 0);
    
    $def(self, '$slice', function $$slice($a) {
      var $post_args, keys, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      keys = $post_args;;
      
      var result = $hash();

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], value = $hash_get(self, key);

        if (value !== undefined) {
          $hash_put(result, key, value);
        }
      }

      return result;
    ;
    }, -1);
    
    $def(self, '$to_a', function $$to_a() {
      var self = this;

      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        result.push([key, value]);
      }

      return result;
    
    }, 0);
    
    $def(self, '$to_h', function $$to_h() {
      var block = $$to_h.$$p || nil, self = this;

      delete $$to_h.$$p;
      
      ;
      if ((block !== nil)) {
        return $send(self, 'map', [], block.$to_proc()).$to_h()
      };
      
      if (self.$$class === Opal.Hash) {
        return self;
      }

      var hash = new Opal.Hash();

      $hash_init(hash);
      Opal.hash_clone(self, hash);

      return hash;
    ;
    }, 0);
    
    $def(self, '$to_hash', $return_self, 0);
    
    $def(self, '$to_proc', function $$to_proc() {
      var self = this;

      return $send(self, 'proc', [], function $$34(key){var self = $$34.$$s == null ? this : $$34.$$s;

        
        ;
        
        if (key == null) {
          $Kernel.$raise($$$('ArgumentError'), "no key given")
        }
      ;
        return self['$[]'](key);}, {$$arity: -1, $$s: self})
    }, 0);
    
    $def(self, '$transform_keys', function $$transform_keys() {
      var block = $$transform_keys.$$p || nil, self = this;

      delete $$transform_keys.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["transform_keys"], function $$35(){var self = $$35.$$s == null ? this : $$35.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var result = $hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        key = $yield1(block, key);

        $hash_put(result, key, value);
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$transform_keys!', function $Hash_transform_keys$excl$36() {
      var block = $Hash_transform_keys$excl$36.$$p || nil, self = this;

      delete $Hash_transform_keys$excl$36.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["transform_keys!"], function $$37(){var self = $$37.$$s == null ? this : $$37.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var keys = Opal.slice.call(self.$$keys),
          i, length = keys.length, key, value, new_key;

      for (i = 0; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        new_key = $yield1(block, key);

        $hash_delete(self, key);
        $hash_put(self, new_key, value);
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$transform_values', function $$transform_values() {
      var block = $$transform_values.$$p || nil, self = this;

      delete $$transform_values.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["transform_values"], function $$38(){var self = $$38.$$s == null ? this : $$38.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var result = $hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        value = $yield1(block, value);

        $hash_put(result, key, value);
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$transform_values!', function $Hash_transform_values$excl$39() {
      var block = $Hash_transform_values$excl$39.$$p || nil, self = this;

      delete $Hash_transform_values$excl$39.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["transform_values!"], function $$40(){var self = $$40.$$s == null ? this : $$40.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        value = $yield1(block, value);

        $hash_put(self, key, value);
      }

      return self;
    ;
    }, 0);
    
    $def(self, '$values', function $$values() {
      var self = this;

      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          result.push(self.$$smap[key]);
        } else {
          result.push(key.value);
        }
      }

      return result;
    
    }, 0);
    $alias(self, "dup", "clone");
    $alias(self, "each_pair", "each");
    $alias(self, "eql?", "==");
    $alias(self, "filter", "select");
    $alias(self, "filter!", "select!");
    $alias(self, "include?", "has_key?");
    $alias(self, "indices", "indexes");
    $alias(self, "key", "index");
    $alias(self, "key?", "has_key?");
    $alias(self, "member?", "has_key?");
    $alias(self, "size", "length");
    $alias(self, "store", "[]=");
    $alias(self, "to_s", "inspect");
    $alias(self, "update", "merge!");
    $alias(self, "value?", "has_value?");
    return $alias(self, "values_at", "indexes");
  })('::', null, $nesting);
};

Opal.modules["corelib/number"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $Opal = Opal.Opal, $Kernel = Opal.Kernel, $def = Opal.def, $eqeqeq = Opal.eqeqeq, $truthy = Opal.truthy, $rb_gt = Opal.rb_gt, $not = Opal.not, $rb_lt = Opal.rb_lt, $alias = Opal.alias, $send2 = Opal.send2, $find_super = Opal.find_super, $send = Opal.send, $rb_plus = Opal.rb_plus, $rb_minus = Opal.rb_minus, $eqeq = Opal.eqeq, $return_self = Opal.return_self, $rb_divide = Opal.rb_divide, $to_ary = Opal.to_ary, $rb_times = Opal.rb_times, $rb_le = Opal.rb_le, $rb_ge = Opal.rb_ge, $return_val = Opal.return_val, $const_set = Opal.const_set;

  Opal.add_stubs('require,bridge,raise,name,class,Float,respond_to?,coerce_to!,__coerced__,===,>,!,**,new,<,to_f,==,nan?,infinite?,enum_for,+,-,gcd,lcm,%,/,frexp,to_i,ldexp,rationalize,*,<<,to_r,truncate,-@,size,<=,>=,inspect,angle,to_s,is_a?,abs,__id__,next,coerce_to?');
  
  self.$require("corelib/numeric");
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Number');

    var $nesting = [self].concat($parent_nesting);

    
    $Opal.$bridge(Number, self);
    Opal.prop(self.$$prototype, '$$is_number', true);
    self.$$is_number_class = true;
    (function(self, $parent_nesting) {
      
      
      
      $def(self, '$allocate', function $$allocate() {
        var self = this;

        return $Kernel.$raise($$$('TypeError'), "allocator undefined for " + (self.$name()))
      }, 0);
      
      
      Opal.udef(self, '$' + "new");;
      return nil;;
    })(Opal.get_singleton_class(self), $nesting);
    
    $def(self, '$coerce', function $$coerce(other) {
      var self = this;

      
      if (other === nil) {
        $Kernel.$raise($$$('TypeError'), "can't convert " + (other.$class()) + " into Float");
      }
      else if (other.$$is_string) {
        return [$Kernel.$Float(other), self];
      }
      else if (other['$respond_to?']("to_f")) {
        return [$Opal['$coerce_to!'](other, $$$('Float'), "to_f"), self];
      }
      else if (other.$$is_number) {
        return [other, self];
      }
      else {
        $Kernel.$raise($$$('TypeError'), "can't convert " + (other.$class()) + " into Float");
      }
    
    }, 1);
    
    $def(self, '$__id__', function $$__id__() {
      var self = this;

      return (self * 2) + 1;
    }, 0);
    
    $def(self, '$+', function $Number_$plus$1(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self + other;
      }
      else {
        return self.$__coerced__("+", other);
      }
    
    }, 1);
    
    $def(self, '$-', function $Number_$minus$2(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self - other;
      }
      else {
        return self.$__coerced__("-", other);
      }
    
    }, 1);
    
    $def(self, '$*', function $Number_$$3(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self * other;
      }
      else {
        return self.$__coerced__("*", other);
      }
    
    }, 1);
    
    $def(self, '$/', function $Number_$slash$4(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self / other;
      }
      else {
        return self.$__coerced__("/", other);
      }
    
    }, 1);
    
    $def(self, '$%', function $Number_$percent$5(other) {
      var self = this;

      
      if (other.$$is_number) {
        if (other == -Infinity) {
          return other;
        }
        else if (other == 0) {
          $Kernel.$raise($$$('ZeroDivisionError'), "divided by 0");
        }
        else if (other < 0 || self < 0) {
          return (self % other + other) % other;
        }
        else {
          return self % other;
        }
      }
      else {
        return self.$__coerced__("%", other);
      }
    
    }, 1);
    
    $def(self, '$&', function $Number_$$6(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self & other;
      }
      else {
        return self.$__coerced__("&", other);
      }
    
    }, 1);
    
    $def(self, '$|', function $Number_$$7(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self | other;
      }
      else {
        return self.$__coerced__("|", other);
      }
    
    }, 1);
    
    $def(self, '$^', function $Number_$$8(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self ^ other;
      }
      else {
        return self.$__coerced__("^", other);
      }
    
    }, 1);
    
    $def(self, '$<', function $Number_$lt$9(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self < other;
      }
      else {
        return self.$__coerced__("<", other);
      }
    
    }, 1);
    
    $def(self, '$<=', function $Number_$lt_eq$10(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self <= other;
      }
      else {
        return self.$__coerced__("<=", other);
      }
    
    }, 1);
    
    $def(self, '$>', function $Number_$gt$11(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self > other;
      }
      else {
        return self.$__coerced__(">", other);
      }
    
    }, 1);
    
    $def(self, '$>=', function $Number_$gt_eq$12(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self >= other;
      }
      else {
        return self.$__coerced__(">=", other);
      }
    
    }, 1);
    
    var spaceship_operator = function(self, other) {
      if (other.$$is_number) {
        if (isNaN(self) || isNaN(other)) {
          return nil;
        }

        if (self > other) {
          return 1;
        } else if (self < other) {
          return -1;
        } else {
          return 0;
        }
      }
      else {
        return self.$__coerced__("<=>", other);
      }
    }
  ;
    
    $def(self, '$<=>', function $Number_$lt_eq_gt$13(other) {
      var self = this;

      try {
        return spaceship_operator(self, other);
      } catch ($err) {
        if (Opal.rescue($err, [$$$('ArgumentError')])) {
          try {
            return nil
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      }
    }, 1);
    
    $def(self, '$<<', function $Number_$lt$lt$14(count) {
      var self = this;

      
      count = $Opal['$coerce_to!'](count, $$$('Integer'), "to_int");
      return count > 0 ? self << count : self >> -count;
    }, 1);
    
    $def(self, '$>>', function $Number_$gt$gt$15(count) {
      var self = this;

      
      count = $Opal['$coerce_to!'](count, $$$('Integer'), "to_int");
      return count > 0 ? self >> count : self << -count;
    }, 1);
    
    $def(self, '$[]', function $Number_$$$16(bit) {
      var self = this;

      
      bit = $Opal['$coerce_to!'](bit, $$$('Integer'), "to_int");
      
      if (bit < 0) {
        return 0;
      }
      if (bit >= 32) {
        return self < 0 ? 1 : 0;
      }
      return (self >> bit) & 1;
    ;
    }, 1);
    
    $def(self, '$+@', function $Number_$plus$$17() {
      var self = this;

      return +self;
    }, 0);
    
    $def(self, '$-@', function $Number_$minus$$18() {
      var self = this;

      return -self;
    }, 0);
    
    $def(self, '$~', function $Number_$$19() {
      var self = this;

      return ~self;
    }, 0);
    
    $def(self, '$**', function $Number_$$$20(other) {
      var self = this;

      if ($eqeqeq($$$('Integer'), other)) {
        if (($not($$$('Integer')['$==='](self)) || ($truthy($rb_gt(other, 0))))) {
          return Math.pow(self, other);
        } else {
          return $$$('Rational').$new(self, 1)['$**'](other)
        }
      } else if (($rb_lt(self, 0) && (($eqeqeq($$$('Float'), other) || ($eqeqeq($$$('Rational'), other)))))) {
        return $$$('Complex').$new(self, 0)['$**'](other.$to_f())
      } else if ($truthy(other.$$is_number != null)) {
        return Math.pow(self, other);
      } else {
        return self.$__coerced__("**", other)
      }
    }, 1);
    
    $def(self, '$==', function $Number_$eq_eq$21(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self.valueOf() === other.valueOf();
      }
      else if (other['$respond_to?']("==")) {
        return other['$=='](self);
      }
      else {
        return false;
      }
    
    }, 1);
    $alias(self, "===", "==");
    
    $def(self, '$abs', function $$abs() {
      var self = this;

      return Math.abs(self);
    }, 0);
    
    $def(self, '$abs2', function $$abs2() {
      var self = this;

      return Math.abs(self * self);
    }, 0);
    
    $def(self, '$allbits?', function $Number_allbits$ques$22(mask) {
      var self = this;

      
      mask = $Opal['$coerce_to!'](mask, $$$('Integer'), "to_int");
      return (self & mask) == mask;;
    }, 1);
    
    $def(self, '$anybits?', function $Number_anybits$ques$23(mask) {
      var self = this;

      
      mask = $Opal['$coerce_to!'](mask, $$$('Integer'), "to_int");
      return (self & mask) !== 0;;
    }, 1);
    
    $def(self, '$angle', function $$angle() {
      var self = this;

      
      if ($truthy(self['$nan?']())) {
        return self
      };
      
      if (self == 0) {
        if (1 / self > 0) {
          return 0;
        }
        else {
          return Math.PI;
        }
      }
      else if (self < 0) {
        return Math.PI;
      }
      else {
        return 0;
      }
    ;
    }, 0);
    
    $def(self, '$bit_length', function $$bit_length() {
      var self = this;

      
      if (!$eqeqeq($$$('Integer'), self)) {
        $Kernel.$raise($$$('NoMethodError').$new("undefined method `bit_length` for " + (self) + ":Float", "bit_length"))
      };
      
      if (self === 0 || self === -1) {
        return 0;
      }

      var result = 0,
          value  = self < 0 ? ~self : self;

      while (value != 0) {
        result   += 1;
        value  >>>= 1;
      }

      return result;
    ;
    }, 0);
    
    $def(self, '$ceil', function $$ceil(ndigits) {
      var self = this;

      
      
      if (ndigits == null) ndigits = 0;;
      
      var f = self.$to_f();

      if (f % 1 === 0 && ndigits >= 0) {
        return f;
      }

      var factor = Math.pow(10, ndigits),
          result = Math.ceil(f * factor) / factor;

      if (f % 1 === 0) {
        result = Math.round(result);
      }

      return result;
    ;
    }, -1);
    
    $def(self, '$chr', function $$chr(encoding) {
      var self = this;

      
      ;
      return Opal.enc(String.fromCharCode(self), encoding || "BINARY");;
    }, -1);
    
    $def(self, '$denominator', function $$denominator() {
      var $yield = $$denominator.$$p || nil, self = this;

      delete $$denominator.$$p;
      if (($truthy(self['$nan?']()) || ($truthy(self['$infinite?']())))) {
        return 1
      } else {
        return $send2(self, $find_super(self, 'denominator', $$denominator, false, true), 'denominator', [], $yield)
      }
    }, 0);
    
    $def(self, '$downto', function $$downto(stop) {
      var block = $$downto.$$p || nil, self = this;

      delete $$downto.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["downto", stop], function $$24(){var self = $$24.$$s == null ? this : $$24.$$s;

          
          if (!$eqeqeq($$$('Numeric'), stop)) {
            $Kernel.$raise($$$('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
          };
          if ($truthy($rb_gt(stop, self))) {
            return 0
          } else {
            return $rb_plus($rb_minus(self, stop), 1)
          };}, {$$arity: 0, $$s: self})
      };
      
      if (!stop.$$is_number) {
        $Kernel.$raise($$$('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
      }
      for (var i = self; i >= stop; i--) {
        block(i);
      }
    ;
      return self;
    }, 1);
    
    $def(self, '$equal?', function $Number_equal$ques$25(other) {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self['$=='](other)))) {
        return $ret_or_1
      } else {
        return isNaN(self) && isNaN(other);
      }
    }, 1);
    
    $def(self, '$even?', function $Number_even$ques$26() {
      var self = this;

      return self % 2 === 0;
    }, 0);
    
    $def(self, '$floor', function $$floor(ndigits) {
      var self = this;

      
      
      if (ndigits == null) ndigits = 0;;
      
      var f = self.$to_f();

      if (f % 1 === 0 && ndigits >= 0) {
        return f;
      }

      var factor = Math.pow(10, ndigits),
          result = Math.floor(f * factor) / factor;

      if (f % 1 === 0) {
        result = Math.round(result);
      }

      return result;
    ;
    }, -1);
    
    $def(self, '$gcd', function $$gcd(other) {
      var self = this;

      
      if (!$eqeqeq($$$('Integer'), other)) {
        $Kernel.$raise($$$('TypeError'), "not an integer")
      };
      
      var min = Math.abs(self),
          max = Math.abs(other);

      while (min > 0) {
        var tmp = min;

        min = max % min;
        max = tmp;
      }

      return max;
    ;
    }, 1);
    
    $def(self, '$gcdlcm', function $$gcdlcm(other) {
      var self = this;

      return [self.$gcd(other), self.$lcm(other)]
    }, 1);
    
    $def(self, '$integer?', function $Number_integer$ques$27() {
      var self = this;

      return self % 1 === 0;
    }, 0);
    
    $def(self, '$is_a?', function $Number_is_a$ques$28(klass) {
      var $yield = $Number_is_a$ques$28.$$p || nil, self = this;

      delete $Number_is_a$ques$28.$$p;
      
      if (($eqeq(klass, $$$('Integer')) && ($eqeqeq($$$('Integer'), self)))) {
        return true
      };
      if (($eqeq(klass, $$$('Integer')) && ($eqeqeq($$$('Integer'), self)))) {
        return true
      };
      if (($eqeq(klass, $$$('Float')) && ($eqeqeq($$$('Float'), self)))) {
        return true
      };
      return $send2(self, $find_super(self, 'is_a?', $Number_is_a$ques$28, false, true), 'is_a?', [klass], $yield);
    }, 1);
    
    $def(self, '$instance_of?', function $Number_instance_of$ques$29(klass) {
      var $yield = $Number_instance_of$ques$29.$$p || nil, self = this;

      delete $Number_instance_of$ques$29.$$p;
      
      if (($eqeq(klass, $$$('Integer')) && ($eqeqeq($$$('Integer'), self)))) {
        return true
      };
      if (($eqeq(klass, $$$('Integer')) && ($eqeqeq($$$('Integer'), self)))) {
        return true
      };
      if (($eqeq(klass, $$$('Float')) && ($eqeqeq($$$('Float'), self)))) {
        return true
      };
      return $send2(self, $find_super(self, 'instance_of?', $Number_instance_of$ques$29, false, true), 'instance_of?', [klass], $yield);
    }, 1);
    
    $def(self, '$lcm', function $$lcm(other) {
      var self = this;

      
      if (!$eqeqeq($$$('Integer'), other)) {
        $Kernel.$raise($$$('TypeError'), "not an integer")
      };
      
      if (self == 0 || other == 0) {
        return 0;
      }
      else {
        return Math.abs(self * other / self.$gcd(other));
      }
    ;
    }, 1);
    
    $def(self, '$next', function $$next() {
      var self = this;

      return self + 1;
    }, 0);
    
    $def(self, '$nobits?', function $Number_nobits$ques$30(mask) {
      var self = this;

      
      mask = $Opal['$coerce_to!'](mask, $$$('Integer'), "to_int");
      return (self & mask) == 0;;
    }, 1);
    
    $def(self, '$nonzero?', function $Number_nonzero$ques$31() {
      var self = this;

      return self == 0 ? nil : self;
    }, 0);
    
    $def(self, '$numerator', function $$numerator() {
      var $yield = $$numerator.$$p || nil, self = this;

      delete $$numerator.$$p;
      if (($truthy(self['$nan?']()) || ($truthy(self['$infinite?']())))) {
        return self
      } else {
        return $send2(self, $find_super(self, 'numerator', $$numerator, false, true), 'numerator', [], $yield)
      }
    }, 0);
    
    $def(self, '$odd?', function $Number_odd$ques$32() {
      var self = this;

      return self % 2 !== 0;
    }, 0);
    
    $def(self, '$ord', $return_self, 0);
    
    $def(self, '$pow', function $$pow(b, m) {
      var self = this;

      
      ;
      
      if (self == 0) {
        $Kernel.$raise($$$('ZeroDivisionError'), "divided by 0")
      }

      if (m === undefined) {
        return self['$**'](b);
      } else {
        if (!($$$('Integer')['$==='](b))) {
          $Kernel.$raise($$$('TypeError'), "Integer#pow() 2nd argument not allowed unless a 1st argument is integer")
        }

        if (b < 0) {
          $Kernel.$raise($$$('TypeError'), "Integer#pow() 1st argument cannot be negative when 2nd argument specified")
        }

        if (!($$$('Integer')['$==='](m))) {
          $Kernel.$raise($$$('TypeError'), "Integer#pow() 2nd argument not allowed unless all arguments are integers")
        }

        if (m === 0) {
          $Kernel.$raise($$$('ZeroDivisionError'), "divided by 0")
        }

        return self['$**'](b)['$%'](m)
      }
    ;
    }, -2);
    
    $def(self, '$pred', function $$pred() {
      var self = this;

      return self - 1;
    }, 0);
    
    $def(self, '$quo', function $$quo(other) {
      var $yield = $$quo.$$p || nil, self = this;

      delete $$quo.$$p;
      if ($eqeqeq($$$('Integer'), self)) {
        return $send2(self, $find_super(self, 'quo', $$quo, false, true), 'quo', [other], $yield)
      } else {
        return $rb_divide(self, other)
      }
    }, 1);
    
    $def(self, '$rationalize', function $$rationalize(eps) {
      var $a, $b, self = this, f = nil, n = nil;

      
      ;
      
      if (arguments.length > 1) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..1)");
      }
    ;
      if ($eqeqeq($$$('Integer'), self)) {
        return $$$('Rational').$new(self, 1)
      } else if ($truthy(self['$infinite?']())) {
        return $Kernel.$raise($$$('FloatDomainError'), "Infinity")
      } else if ($truthy(self['$nan?']())) {
        return $Kernel.$raise($$$('FloatDomainError'), "NaN")
      } else if ($truthy(eps == null)) {
        
        $b = $$$('Math').$frexp(self), $a = $to_ary($b), (f = ($a[0] == null ? nil : $a[0])), (n = ($a[1] == null ? nil : $a[1])), $b;
        f = $$$('Math').$ldexp(f, $$$($$$('Float'), 'MANT_DIG')).$to_i();
        n = $rb_minus(n, $$$($$$('Float'), 'MANT_DIG'));
        return $$$('Rational').$new($rb_times(2, f), (1)['$<<']($rb_minus(1, n))).$rationalize($$$('Rational').$new(1, (1)['$<<']($rb_minus(1, n))));
      } else {
        return self.$to_r().$rationalize(eps)
      };
    }, -1);
    
    $def(self, '$remainder', function $$remainder(y) {
      var self = this;

      return $rb_minus(self, $rb_times(y, $rb_divide(self, y).$truncate()))
    }, 1);
    
    $def(self, '$round', function $$round(ndigits) {
      var $a, $b, self = this, _ = nil, exp = nil;

      
      ;
      if ($eqeqeq($$$('Integer'), self)) {
        
        if ($truthy(ndigits == null)) {
          return self
        };
        if (($eqeqeq($$$('Float'), ndigits) && ($truthy(ndigits['$infinite?']())))) {
          $Kernel.$raise($$$('RangeError'), "Infinity")
        };
        ndigits = $Opal['$coerce_to!'](ndigits, $$$('Integer'), "to_int");
        if ($truthy($rb_lt(ndigits, $$$($$$('Integer'), 'MIN')))) {
          $Kernel.$raise($$$('RangeError'), "out of bounds")
        };
        if ($truthy(ndigits >= 0)) {
          return self
        };
        ndigits = ndigits['$-@']();
        
        if (0.415241 * ndigits - 0.125 > self.$size()) {
          return 0;
        }

        var f = Math.pow(10, ndigits),
            x = Math.floor((Math.abs(self) + f / 2) / f) * f;

        return self < 0 ? -x : x;
      ;
      } else {
        
        if (($truthy(self['$nan?']()) && ($truthy(ndigits == null)))) {
          $Kernel.$raise($$$('FloatDomainError'), "NaN")
        };
        ndigits = $Opal['$coerce_to!'](ndigits || 0, $$$('Integer'), "to_int");
        if ($truthy($rb_le(ndigits, 0))) {
          if ($truthy(self['$nan?']())) {
            $Kernel.$raise($$$('RangeError'), "NaN")
          } else if ($truthy(self['$infinite?']())) {
            $Kernel.$raise($$$('FloatDomainError'), "Infinity")
          }
        } else if ($eqeq(ndigits, 0)) {
          return Math.round(self)
        } else if (($truthy(self['$nan?']()) || ($truthy(self['$infinite?']())))) {
          return self
        };
        $b = $$$('Math').$frexp(self), $a = $to_ary($b), (_ = ($a[0] == null ? nil : $a[0])), (exp = ($a[1] == null ? nil : $a[1])), $b;
        if ($truthy($rb_ge(ndigits, $rb_minus($rb_plus($$$($$$('Float'), 'DIG'), 2), ($truthy($rb_gt(exp, 0)) ? ($rb_divide(exp, 4)) : ($rb_minus($rb_divide(exp, 3), 1))))))) {
          return self
        };
        if ($truthy($rb_lt(ndigits, ($truthy($rb_gt(exp, 0)) ? ($rb_plus($rb_divide(exp, 3), 1)) : ($rb_divide(exp, 4)))['$-@']()))) {
          return 0
        };
        return Math.round(self * Math.pow(10, ndigits)) / Math.pow(10, ndigits);;
      };
    }, -1);
    
    $def(self, '$times', function $$times() {
      var block = $$times.$$p || nil, self = this;

      delete $$times.$$p;
      
      ;
      if (!$truthy(block)) {
        return $send(self, 'enum_for', ["times"], function $$33(){var self = $$33.$$s == null ? this : $$33.$$s;

          return self}, {$$arity: 0, $$s: self})
      };
      
      for (var i = 0; i < self; i++) {
        block(i);
      }
    ;
      return self;
    }, 0);
    
    $def(self, '$to_f', $return_self, 0);
    
    $def(self, '$to_i', function $$to_i() {
      var self = this;

      return self < 0 ? Math.ceil(self) : Math.floor(self);
    }, 0);
    
    $def(self, '$to_r', function $$to_r() {
      var $a, $b, self = this, f = nil, e = nil;

      if ($eqeqeq($$$('Integer'), self)) {
        return $$$('Rational').$new(self, 1)
      } else {
        
        $b = $$$('Math').$frexp(self), $a = $to_ary($b), (f = ($a[0] == null ? nil : $a[0])), (e = ($a[1] == null ? nil : $a[1])), $b;
        f = $$$('Math').$ldexp(f, $$$($$$('Float'), 'MANT_DIG')).$to_i();
        e = $rb_minus(e, $$$($$$('Float'), 'MANT_DIG'));
        return $rb_times(f, $$$($$$('Float'), 'RADIX')['$**'](e)).$to_r();
      }
    }, 0);
    
    $def(self, '$to_s', function $$to_s(base) {
      var self = this;

      
      
      if (base == null) base = 10;;
      base = $Opal['$coerce_to!'](base, $$$('Integer'), "to_int");
      if (($truthy($rb_lt(base, 2)) || ($truthy($rb_gt(base, 36))))) {
        $Kernel.$raise($$$('ArgumentError'), "invalid radix " + (base))
      };
      if (($eqeq(self, 0) && ($truthy(1/self === -Infinity)))) {
        return "-0.0"
      };
      return self.toString(base);;
    }, -1);
    
    $def(self, '$truncate', function $$truncate(ndigits) {
      var self = this;

      
      
      if (ndigits == null) ndigits = 0;;
      
      var f = self.$to_f();

      if (f % 1 === 0 && ndigits >= 0) {
        return f;
      }

      var factor = Math.pow(10, ndigits),
          result = parseInt(f * factor, 10) / factor;

      if (f % 1 === 0) {
        result = Math.round(result);
      }

      return result;
    ;
    }, -1);
    
    $def(self, '$digits', function $$digits(base) {
      var self = this;

      
      
      if (base == null) base = 10;;
      if ($rb_lt(self, 0)) {
        $Kernel.$raise($$$($$$('Math'), 'DomainError'), "out of domain")
      };
      base = $Opal['$coerce_to!'](base, $$$('Integer'), "to_int");
      if ($truthy($rb_lt(base, 2))) {
        $Kernel.$raise($$$('ArgumentError'), "invalid radix " + (base))
      };
      
      if (self != parseInt(self)) $Kernel.$raise($$$('NoMethodError'), "undefined method `digits' for " + (self.$inspect()))

      var value = self, result = [];

      if (self == 0) {
        return [0];
      }

      while (value != 0) {
        result.push(value % base);
        value = parseInt(value / base, 10);
      }

      return result;
    ;
    }, -1);
    
    $def(self, '$divmod', function $$divmod(other) {
      var $yield = $$divmod.$$p || nil, self = this;

      delete $$divmod.$$p;
      if (($truthy(self['$nan?']()) || ($truthy(other['$nan?']())))) {
        return $Kernel.$raise($$$('FloatDomainError'), "NaN")
      } else if ($truthy(self['$infinite?']())) {
        return $Kernel.$raise($$$('FloatDomainError'), "Infinity")
      } else {
        return $send2(self, $find_super(self, 'divmod', $$divmod, false, true), 'divmod', [other], $yield)
      }
    }, 1);
    
    $def(self, '$upto', function $$upto(stop) {
      var block = $$upto.$$p || nil, self = this;

      delete $$upto.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["upto", stop], function $$34(){var self = $$34.$$s == null ? this : $$34.$$s;

          
          if (!$eqeqeq($$$('Numeric'), stop)) {
            $Kernel.$raise($$$('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
          };
          if ($truthy($rb_lt(stop, self))) {
            return 0
          } else {
            return $rb_plus($rb_minus(stop, self), 1)
          };}, {$$arity: 0, $$s: self})
      };
      
      if (!stop.$$is_number) {
        $Kernel.$raise($$$('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
      }
      for (var i = self; i <= stop; i++) {
        block(i);
      }
    ;
      return self;
    }, 1);
    
    $def(self, '$zero?', function $Number_zero$ques$35() {
      var self = this;

      return self == 0;
    }, 0);
    
    $def(self, '$size', $return_val(4), 0);
    
    $def(self, '$nan?', function $Number_nan$ques$36() {
      var self = this;

      return isNaN(self);
    }, 0);
    
    $def(self, '$finite?', function $Number_finite$ques$37() {
      var self = this;

      return self != Infinity && self != -Infinity && !isNaN(self);
    }, 0);
    
    $def(self, '$infinite?', function $Number_infinite$ques$38() {
      var self = this;

      
      if (self == Infinity) {
        return +1;
      }
      else if (self == -Infinity) {
        return -1;
      }
      else {
        return nil;
      }
    
    }, 0);
    
    $def(self, '$positive?', function $Number_positive$ques$39() {
      var self = this;

      return self != 0 && (self == Infinity || 1 / self > 0);
    }, 0);
    
    $def(self, '$negative?', function $Number_negative$ques$40() {
      var self = this;

      return self == -Infinity || 1 / self < 0;
    }, 0);
    
    function numberToUint8Array(num) {
      var uint8array = new Uint8Array(8);
      new DataView(uint8array.buffer).setFloat64(0, num, true);
      return uint8array;
    }

    function uint8ArrayToNumber(arr) {
      return new DataView(arr.buffer).getFloat64(0, true);
    }

    function incrementNumberBit(num) {
      var arr = numberToUint8Array(num);
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] === 0xff) {
          arr[i] = 0;
        } else {
          arr[i]++;
          break;
        }
      }
      return uint8ArrayToNumber(arr);
    }

    function decrementNumberBit(num) {
      var arr = numberToUint8Array(num);
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] === 0) {
          arr[i] = 0xff;
        } else {
          arr[i]--;
          break;
        }
      }
      return uint8ArrayToNumber(arr);
    }
  ;
    
    $def(self, '$next_float', function $$next_float() {
      var self = this;

      
      if ($eqeq(self, $$$($$$('Float'), 'INFINITY'))) {
        return $$$($$$('Float'), 'INFINITY')
      };
      if ($truthy(self['$nan?']())) {
        return $$$($$$('Float'), 'NAN')
      };
      if ($rb_ge(self, 0)) {
        return incrementNumberBit(Math.abs(self));
      } else {
        return decrementNumberBit(self);
      };
    }, 0);
    
    $def(self, '$prev_float', function $$prev_float() {
      var self = this;

      
      if ($eqeq(self, $$$($$$('Float'), 'INFINITY')['$-@']())) {
        return $$$($$$('Float'), 'INFINITY')['$-@']()
      };
      if ($truthy(self['$nan?']())) {
        return $$$($$$('Float'), 'NAN')
      };
      if ($rb_gt(self, 0)) {
        return decrementNumberBit(self);
      } else {
        return -incrementNumberBit(Math.abs(self));
      };
    }, 0);
    $alias(self, "arg", "angle");
    $alias(self, "eql?", "==");
    $alias(self, "fdiv", "/");
    $alias(self, "inspect", "to_s");
    $alias(self, "kind_of?", "is_a?");
    $alias(self, "magnitude", "abs");
    $alias(self, "modulo", "%");
    $alias(self, "object_id", "__id__");
    $alias(self, "phase", "angle");
    $alias(self, "succ", "next");
    return $alias(self, "to_int", "to_i");
  })('::', $$$('Numeric'), $nesting);
  $const_set('::', 'Fixnum', $$$('Number'));
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Integer');

    var $nesting = [self].concat($parent_nesting);

    
    self.$$is_number_class = true;
    self.$$is_integer_class = true;
    (function(self, $parent_nesting) {
      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      
      $def(self, '$allocate', function $$allocate() {
        var self = this;

        return $Kernel.$raise($$$('TypeError'), "allocator undefined for " + (self.$name()))
      }, 0);
      
      Opal.udef(self, '$' + "new");;
      
      $def(self, '$sqrt', function $$sqrt(n) {
        
        
        n = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
        
        if (n < 0) {
          $Kernel.$raise($$$($$$('Math'), 'DomainError'), "Numerical argument is out of domain - \"isqrt\"")
        }

        return parseInt(Math.sqrt(n), 10);
      ;
      }, 1);
      return $def(self, '$try_convert', function $$try_convert(object) {
        var self = this;

        return $$('Opal')['$coerce_to?'](object, self, "to_int")
      }, 1);
    })(Opal.get_singleton_class(self), $nesting);
    $const_set(self, 'MAX', Math.pow(2, 30) - 1);
    return $const_set(self, 'MIN', -Math.pow(2, 30));
  })('::', $$$('Numeric'), $nesting);
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Float');

    var $nesting = [self].concat($parent_nesting);

    
    self.$$is_number_class = true;
    (function(self, $parent_nesting) {
      
      
      
      $def(self, '$allocate', function $$allocate() {
        var self = this;

        return $Kernel.$raise($$$('TypeError'), "allocator undefined for " + (self.$name()))
      }, 0);
      
      Opal.udef(self, '$' + "new");;
      return $def(self, '$===', function $eq_eq_eq$41(other) {
        
        return !!other.$$is_number;
      }, 1);
    })(Opal.get_singleton_class(self), $nesting);
    $const_set(self, 'INFINITY', Infinity);
    $const_set(self, 'MAX', Number.MAX_VALUE);
    $const_set(self, 'MIN', Number.MIN_VALUE);
    $const_set(self, 'NAN', NaN);
    $const_set(self, 'DIG', 15);
    $const_set(self, 'MANT_DIG', 53);
    $const_set(self, 'RADIX', 2);
    return $const_set(self, 'EPSILON', Number.EPSILON || 2.2204460492503130808472633361816E-16);
  })('::', $$$('Numeric'), $nesting);
};

Opal.modules["corelib/range"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $truthy = Opal.truthy, $Kernel = Opal.Kernel, $def = Opal.def, $not = Opal.not, $send2 = Opal.send2, $find_super = Opal.find_super, $rb_lt = Opal.rb_lt, $rb_le = Opal.rb_le, $send = Opal.send, $eqeq = Opal.eqeq, $eqeqeq = Opal.eqeqeq, $return_ivar = Opal.return_ivar, $rb_gt = Opal.rb_gt, $rb_minus = Opal.rb_minus, $Opal = Opal.Opal, $rb_divide = Opal.rb_divide, $rb_plus = Opal.rb_plus, $rb_times = Opal.rb_times, $rb_ge = Opal.rb_ge, $alias = Opal.alias;

  Opal.add_stubs('require,include,attr_reader,raise,nil?,<=>,include?,!,<,<=,enum_for,size,upto,to_proc,respond_to?,class,succ,==,===,exclude_end?,eql?,begin,end,last,to_a,>,-@,-,to_i,coerce_to!,ceil,/,is_a?,new,loop,+,*,>=,each_with_index,%,step,bsearch,inspect,[],hash,cover?');
  
  self.$require("corelib/enumerable");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Range');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.begin = $proto.end = $proto.excl = nil;
    
    self.$include($$$('Enumerable'));
    self.$$prototype.$$is_range = true;
    self.$attr_reader("begin", "end");
    
    $def(self, '$initialize', function $$initialize(first, last, exclude) {
      var self = this;

      
      
      if (exclude == null) exclude = false;;
      if ($truthy(self.begin)) {
        $Kernel.$raise($$$('NameError'), "'initialize' called twice")
      };
      if (!(($truthy(first['$<=>'](last)) || ($truthy(first['$nil?']()))) || ($truthy(last['$nil?']())))) {
        $Kernel.$raise($$$('ArgumentError'), "bad value for range")
      };
      self.begin = first;
      self.end = last;
      return (self.excl = exclude);
    }, -3);
    
    $def(self, '$===', function $Range_$eq_eq_eq$1(value) {
      var self = this;

      return self['$include?'](value)
    }, 1);
    
    function is_infinite(self) {
      if (self.begin === nil || self.end === nil ||
          self.begin === -Infinity || self.end === Infinity ||
          self.begin === Infinity || self.end === -Infinity) return true;
      return false;
    }
  ;
    
    $def(self, '$count', function $$count() {
      var block = $$count.$$p || nil, self = this;

      delete $$count.$$p;
      
      ;
      if (($not((block !== nil)) && ($truthy(is_infinite(self))))) {
        return $$$($$$('Float'), 'INFINITY')
      };
      return $send2(self, $find_super(self, 'count', $$count, false, true), 'count', [], block);
    }, 0);
    
    $def(self, '$to_a', function $$to_a() {
      var $yield = $$to_a.$$p || nil, self = this;

      delete $$to_a.$$p;
      
      if ($truthy(is_infinite(self))) {
        $Kernel.$raise($$$('TypeError'), "cannot convert endless range to an array")
      };
      return $send2(self, $find_super(self, 'to_a', $$to_a, false, true), 'to_a', [], $yield);
    }, 0);
    
    $def(self, '$cover?', function $Range_cover$ques$2(value) {
      var self = this, beg_cmp = nil, $ret_or_1 = nil, $ret_or_2 = nil, $ret_or_3 = nil, end_cmp = nil;

      
      beg_cmp = ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = ($truthy(($ret_or_3 = self.begin['$nil?']())) ? (-1) : ($ret_or_3)))) ? ($ret_or_2) : (self.begin['$<=>'](value))))) && ($ret_or_1));
      end_cmp = ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = ($truthy(($ret_or_3 = self.end['$nil?']())) ? (-1) : ($ret_or_3)))) ? ($ret_or_2) : (value['$<=>'](self.end))))) && ($ret_or_1));
      if ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = ($truthy(self.excl) ? (($truthy(($ret_or_3 = end_cmp)) ? ($rb_lt(end_cmp, 0)) : ($ret_or_3))) : ($truthy(($ret_or_3 = end_cmp)) ? ($rb_le(end_cmp, 0)) : ($ret_or_3))))) ? (beg_cmp) : ($ret_or_2))))) {
        return $rb_le(beg_cmp, 0)
      } else {
        return $ret_or_1
      };
    }, 1);
    
    $def(self, '$each', function $$each() {
      var block = $$each.$$p || nil, $a, self = this, current = nil, last = nil, $ret_or_1 = nil;

      delete $$each.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each"], function $$3(){var self = $$3.$$s == null ? this : $$3.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      
      var i, limit;

      if (self.begin.$$is_number && self.end.$$is_number) {
        if (self.begin % 1 !== 0 || self.end % 1 !== 0) {
          $Kernel.$raise($$$('TypeError'), "can't iterate from Float")
        }

        for (i = self.begin, limit = self.end + ($truthy(self.excl) ? (0) : (1)); i < limit; i++) {
          block(i);
        }

        return self;
      }

      if (self.begin.$$is_string && self.end.$$is_string) {
        $send(self.begin, 'upto', [self.end, self.excl], block.$to_proc())
        return self;
      }
    ;
      current = self.begin;
      last = self.end;
      if (!$truthy(current['$respond_to?']("succ"))) {
        $Kernel.$raise($$$('TypeError'), "can't iterate from " + (current.$class()))
      };
      while ($truthy(($truthy(($ret_or_1 = self.end['$nil?']())) ? ($ret_or_1) : ($rb_lt(current['$<=>'](last), 0))))) {
        
        Opal.yield1(block, current);
        current = current.$succ();
      };
      if (($not(self.excl) && ($eqeq(current, last)))) {
        Opal.yield1(block, current)
      };
      return self;
    }, 0);
    
    $def(self, '$eql?', function $Range_eql$ques$4(other) {
      var self = this, $ret_or_1 = nil, $ret_or_2 = nil;

      
      if (!$eqeqeq($$$('Range'), other)) {
        return false
      };
      if ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = self.excl['$==='](other['$exclude_end?']()))) ? (self.begin['$eql?'](other.$begin())) : ($ret_or_2))))) {
        return self.end['$eql?'](other.$end())
      } else {
        return $ret_or_1
      };
    }, 1);
    
    $def(self, '$exclude_end?', $return_ivar("excl"), 0);
    
    $def(self, '$first', function $$first(n) {
      var $yield = $$first.$$p || nil, self = this;

      delete $$first.$$p;
      
      ;
      if ($truthy(self.begin['$nil?']())) {
        $Kernel.$raise($$$('RangeError'), "cannot get the minimum of beginless range")
      };
      if ($truthy(n == null)) {
        return self.begin
      };
      return $send2(self, $find_super(self, 'first', $$first, false, true), 'first', [n], $yield);
    }, -1);
    
    $def(self, '$last', function $$last(n) {
      var self = this;

      
      ;
      if ($truthy(self.end['$nil?']())) {
        $Kernel.$raise($$$('RangeError'), "cannot get the maximum of endless range")
      };
      if ($truthy(n == null)) {
        return self.end
      };
      return self.$to_a().$last(n);
    }, -1);
    
    $def(self, '$max', function $$max() {
      var $yield = $$max.$$p || nil, self = this;

      delete $$max.$$p;
      if ($truthy(self.end['$nil?']())) {
        return $Kernel.$raise($$$('RangeError'), "cannot get the maximum of endless range")
      } else if (($yield !== nil)) {
        return $send2(self, $find_super(self, 'max', $$max, false, true), 'max', [], $yield)
      } else if (($not(self.begin['$nil?']()) && (($truthy($rb_gt(self.begin, self.end)) || (($truthy(self.excl) && ($eqeq(self.begin, self.end)))))))) {
        return nil
      } else {
        return self.excl ? self.end - 1 : self.end
      }
    }, 0);
    
    $def(self, '$min', function $$min() {
      var $yield = $$min.$$p || nil, self = this;

      delete $$min.$$p;
      if ($truthy(self.begin['$nil?']())) {
        return $Kernel.$raise($$$('RangeError'), "cannot get the minimum of beginless range")
      } else if (($yield !== nil)) {
        return $send2(self, $find_super(self, 'min', $$min, false, true), 'min', [], $yield)
      } else if (($not(self.end['$nil?']()) && (($truthy($rb_gt(self.begin, self.end)) || (($truthy(self.excl) && ($eqeq(self.begin, self.end)))))))) {
        return nil
      } else {
        return self.begin
      }
    }, 0);
    
    $def(self, '$size', function $$size() {
      var self = this, infinity = nil, range_begin = nil, range_end = nil;

      
      infinity = $$$($$$('Float'), 'INFINITY');
      if ((($eqeq(self.begin, infinity) && ($not(self.end['$nil?']()))) || (($eqeq(self.end, infinity['$-@']()) && ($not(self.begin['$nil?']())))))) {
        return 0
      };
      if ($truthy(is_infinite(self))) {
        return infinity
      };
      if (!($eqeqeq($$$('Numeric'), self.begin) && ($eqeqeq($$$('Numeric'), self.end)))) {
        return nil
      };
      range_begin = self.begin;
      range_end = self.end;
      if ($truthy(self.excl)) {
        range_end = $rb_minus(range_end, 1)
      };
      if ($truthy($rb_lt(range_end, range_begin))) {
        return 0
      };
      return (Math.abs(range_end - range_begin) + 1).$to_i();
    }, 0);
    
    $def(self, '$step', function $$step(n) {
      var $yield = $$step.$$p || nil, self = this, $ret_or_1 = nil, i = nil;

      delete $$step.$$p;
      
      ;
      
      function coerceStepSize() {
        if (n == null) {
          n = 1;
        }
        else if (!n.$$is_number) {
          n = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int")
        }

        if (n < 0) {
          $Kernel.$raise($$$('ArgumentError'), "step can't be negative")
        } else if (n === 0) {
          $Kernel.$raise($$$('ArgumentError'), "step can't be 0")
        }
      }

      function enumeratorSize() {
        if (!self.begin['$respond_to?']("succ")) {
          return nil;
        }

        if (self.begin.$$is_string && self.end.$$is_string) {
          return nil;
        }

        if (n % 1 === 0) {
          return $rb_divide(self.$size(), n).$ceil();
        } else {
          // n is a float
          var begin = self.begin, end = self.end,
              abs = Math.abs, floor = Math.floor,
              err = (abs(begin) + abs(end) + abs(end - begin)) / abs(n) * $$$($$$('Float'), 'EPSILON'),
              size;

          if (err > 0.5) {
            err = 0.5;
          }

          if (self.excl) {
            size = floor((end - begin) / n - err);
            if (size * n + begin < end) {
              size++;
            }
          } else {
            size = floor((end - begin) / n + err) + 1
          }

          return size;
        }
      }
    ;
      if (!($yield !== nil)) {
        if (((($truthy(self.begin['$is_a?']($$('Numeric'))) || ($truthy(self.begin['$nil?']()))) && (($truthy(self.end['$is_a?']($$('Numeric'))) || ($truthy(self.end['$nil?']()))))) && ($not(($truthy(($ret_or_1 = self.begin['$nil?']())) ? (self.end['$nil?']()) : ($ret_or_1)))))) {
          return $$$($$$('Enumerator'), 'ArithmeticSequence').$new(self, n, "step")
        } else {
          return $send(self, 'enum_for', ["step", n], function $$5(){
            
            coerceStepSize();
            return enumeratorSize();
          }, 0)
        }
      };
      coerceStepSize();
      if ($truthy(self.begin.$$is_number && self.end.$$is_number)) {
        
        i = 0;
        (function(){var $brk = Opal.new_brk(); try {return $send(self, 'loop', [], function $$6(){var self = $$6.$$s == null ? this : $$6.$$s, current = nil;
          if (self.begin == null) self.begin = nil;
          if (self.excl == null) self.excl = nil;
          if (self.end == null) self.end = nil;

          
          current = $rb_plus(self.begin, $rb_times(i, n));
          if ($truthy(self.excl)) {
            if ($truthy($rb_ge(current, self.end))) {
              
              Opal.brk(nil, $brk)
            }
          } else if ($truthy($rb_gt(current, self.end))) {
            
            Opal.brk(nil, $brk)
          };
          Opal.yield1($yield, current);
          return (i = $rb_plus(i, 1));}, {$$arity: 0, $$s: self, $$brk: $brk})
        } catch (err) { if (err === $brk) { return err.$v } else { throw err } }})();
      } else {
        
        
        if (self.begin.$$is_string && self.end.$$is_string && n % 1 !== 0) {
          $Kernel.$raise($$$('TypeError'), "no implicit conversion to float from string")
        }
      ;
        $send(self, 'each_with_index', [], function $$7(value, idx){
          
          
          if (value == null) value = nil;;
          
          if (idx == null) idx = nil;;
          if ($eqeq(idx['$%'](n), 0)) {
            return Opal.yield1($yield, value);
          } else {
            return nil
          };}, 2);
      };
      return self;
    }, -1);
    
    $def(self, '$%', function $Range_$percent$8(n) {
      var self = this;

      if (($truthy(self.begin['$is_a?']($$('Numeric'))) && ($truthy(self.end['$is_a?']($$('Numeric')))))) {
        return $$$($$$('Enumerator'), 'ArithmeticSequence').$new(self, n, "%")
      } else {
        return self.$step(n)
      }
    }, 1);
    
    $def(self, '$bsearch', function $$bsearch() {
      var block = $$bsearch.$$p || nil, self = this;

      delete $$bsearch.$$p;
      
      ;
      if (!(block !== nil)) {
        return self.$enum_for("bsearch")
      };
      if ($truthy(is_infinite(self) && (self.begin.$$is_number || self.end.$$is_number))) {
        $Kernel.$raise($$$('NotImplementedError'), "Can't #bsearch an infinite range")
      };
      if (!$truthy(self.begin.$$is_number && self.end.$$is_number)) {
        $Kernel.$raise($$$('TypeError'), "can't do binary search for " + (self.begin.$class()))
      };
      return $send(self.$to_a(), 'bsearch', [], block.$to_proc());
    }, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this, $ret_or_1 = nil;

      return "" + (($truthy(($ret_or_1 = self.begin)) ? ($ret_or_1) : (""))) + (($truthy(self.excl) ? ("...") : (".."))) + (($truthy(($ret_or_1 = self.end)) ? ($ret_or_1) : ("")))
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this, $ret_or_1 = nil;

      return "" + (($truthy(($ret_or_1 = self.begin)) ? (self.begin.$inspect()) : ($ret_or_1))) + (($truthy(self.excl) ? ("...") : (".."))) + (($truthy(($ret_or_1 = self.end)) ? (self.end.$inspect()) : ($ret_or_1)))
    }, 0);
    
    $def(self, '$marshal_load', function $$marshal_load(args) {
      var self = this;

      
      self.begin = args['$[]']("begin");
      self.end = args['$[]']("end");
      return (self.excl = args['$[]']("excl"));
    }, 1);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      return [self.begin, self.end, self.excl].$hash()
    }, 0);
    $alias(self, "==", "eql?");
    $alias(self, "include?", "cover?");
    return $alias(self, "member?", "cover?");
  })('::', null, $nesting);
};

Opal.modules["corelib/proc"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $slice = Opal.slice, $klass = Opal.klass, $truthy = Opal.truthy, $Kernel = Opal.Kernel, $defs = Opal.defs, $def = Opal.def, $send = Opal.send, $to_a = Opal.to_a, $return_self = Opal.return_self, $Opal = Opal.Opal, $alias = Opal.alias;

  Opal.add_stubs('raise,proc,call,to_proc,new,source_location,coerce_to!,dup');
  return (function($base, $super) {
    var self = $klass($base, $super, 'Proc');

    
    
    Opal.prop(self.$$prototype, '$$is_proc', true);
    Opal.prop(self.$$prototype, '$$is_lambda', false);
    $defs(self, '$new', function $Proc_new$1() {
      var block = $Proc_new$1.$$p || nil;

      delete $Proc_new$1.$$p;
      
      ;
      if (!$truthy(block)) {
        $Kernel.$raise($$$('ArgumentError'), "tried to create a Proc object without a block")
      };
      return block;
    }, 0);
    
    $def(self, '$call', function $$call($a) {
      var block = $$call.$$p || nil, $post_args, args, self = this;

      delete $$call.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      if (block !== nil) {
        self.$$p = block;
      }

      var result, $brk = self.$$brk;

      if ($brk) {
        try {
          if (self.$$is_lambda) {
            result = self.apply(null, args);
          }
          else {
            result = Opal.yieldX(self, args);
          }
        } catch (err) {
          if (err === $brk) {
            return $brk.$v
          }
          else {
            throw err
          }
        }
      }
      else {
        if (self.$$is_lambda) {
          result = self.apply(null, args);
        }
        else {
          result = Opal.yieldX(self, args);
        }
      }

      return result;
    ;
    }, -1);
    
    $def(self, '$>>', function $Proc_$gt$gt$2(other) {
      var $yield = $Proc_$gt$gt$2.$$p || nil, self = this;

      delete $Proc_$gt$gt$2.$$p;
      return $send($Kernel, 'proc', [], function $$3($a){var block = $$3.$$p || nil, $post_args, args, self = $$3.$$s == null ? this : $$3.$$s, out = nil;

        delete $$3.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        out = $send(self, 'call', $to_a(args), block.$to_proc());
        return other.$call(out);}, {$$arity: -1, $$s: self})
    }, 1);
    
    $def(self, '$<<', function $Proc_$lt$lt$4(other) {
      var $yield = $Proc_$lt$lt$4.$$p || nil, self = this;

      delete $Proc_$lt$lt$4.$$p;
      return $send($Kernel, 'proc', [], function $$5($a){var block = $$5.$$p || nil, $post_args, args, self = $$5.$$s == null ? this : $$5.$$s, out = nil;

        delete $$5.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        out = $send(other, 'call', $to_a(args), block.$to_proc());
        return self.$call(out);}, {$$arity: -1, $$s: self})
    }, 1);
    
    $def(self, '$to_proc', $return_self, 0);
    
    $def(self, '$lambda?', function $Proc_lambda$ques$6() {
      var self = this;

      return !!self.$$is_lambda;
    }, 0);
    
    $def(self, '$arity', function $$arity() {
      var self = this;

      
      if (self.$$is_curried) {
        return -1;
      } else {
        return self.$$arity;
      }
    
    }, 0);
    
    $def(self, '$source_location', function $$source_location() {
      var self = this;

      
      if (self.$$is_curried) { return nil; };
      return nil;
    }, 0);
    
    $def(self, '$binding', function $$binding() {
      var $a, self = this;

      
      if (self.$$is_curried) { $Kernel.$raise($$$('ArgumentError'), "Can't create Binding") };
      if ($truthy((($a = $$$('::', 'Binding', 'skip_raise')) ? 'constant' : nil))) {
        return $$$('Binding').$new(nil, [], self.$$s, self.$source_location())
      } else {
        return nil
      };
    }, 0);
    
    $def(self, '$parameters', function $$parameters() {
      var self = this;

      
      if (self.$$is_curried) {
        return [["rest"]];
      } else if (self.$$parameters) {
        if (self.$$is_lambda) {
          return self.$$parameters;
        } else {
          var result = [], i, length;

          for (i = 0, length = self.$$parameters.length; i < length; i++) {
            var parameter = self.$$parameters[i];

            if (parameter[0] === 'req') {
              // required arguments always have name
              parameter = ['opt', parameter[1]];
            }

            result.push(parameter);
          }

          return result;
        }
      } else {
        return [];
      }
    
    }, 0);
    
    $def(self, '$curry', function $$curry(arity) {
      var self = this;

      
      ;
      
      if (arity === undefined) {
        arity = self.length;
      }
      else {
        arity = $Opal['$coerce_to!'](arity, $$$('Integer'), "to_int");
        if (self.$$is_lambda && arity !== self.length) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arity) + " for " + (self.length) + ")")
        }
      }

      function curried () {
        var args = $slice.call(arguments),
            length = args.length,
            result;

        if (length > arity && self.$$is_lambda && !self.$$is_curried) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (length) + " for " + (arity) + ")")
        }

        if (length >= arity) {
          return self.$call.apply(self, args);
        }

        result = function () {
          return curried.apply(null,
            args.concat($slice.call(arguments)));
        }
        result.$$is_lambda = self.$$is_lambda;
        result.$$is_curried = true;

        return result;
      };

      curried.$$is_lambda = self.$$is_lambda;
      curried.$$is_curried = true;
      return curried;
    ;
    }, -1);
    
    $def(self, '$dup', function $$dup() {
      var self = this;

      
      var original_proc = self.$$original_proc || self,
          proc = function () {
            return original_proc.apply(this, arguments);
          };

      for (var prop in self) {
        if (self.hasOwnProperty(prop)) {
          proc[prop] = self[prop];
        }
      }

      return proc;
    
    }, 0);
    $alias(self, "===", "call");
    $alias(self, "clone", "dup");
    $alias(self, "yield", "call");
    return $alias(self, "[]", "call");
  })('::', Function)
};

Opal.modules["corelib/method"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $def = Opal.def, $truthy = Opal.truthy, $alias = Opal.alias, $Kernel = Opal.Kernel, $send = Opal.send, $to_a = Opal.to_a;

  Opal.add_stubs('attr_reader,arity,curry,>>,<<,new,class,join,source_location,call,raise,bind,to_proc');
  
  (function($base, $super) {
    var self = $klass($base, $super, 'Method');

    var $proto = self.$$prototype;

    $proto.method = $proto.receiver = $proto.owner = $proto.name = nil;
    
    self.$attr_reader("owner", "receiver", "name");
    
    $def(self, '$initialize', function $$initialize(receiver, owner, method, name) {
      var self = this;

      
      self.receiver = receiver;
      self.owner = owner;
      self.name = name;
      return (self.method = method);
    }, 4);
    
    $def(self, '$arity', function $$arity() {
      var self = this;

      return self.method.$arity()
    }, 0);
    
    $def(self, '$parameters', function $$parameters() {
      var self = this;

      return self.method.$$parameters
    }, 0);
    
    $def(self, '$source_location', function $$source_location() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.method.$$source_location))) {
        return $ret_or_1
      } else {
        return ["(eval)", 0]
      }
    }, 0);
    
    $def(self, '$comments', function $$comments() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.method.$$comments))) {
        return $ret_or_1
      } else {
        return []
      }
    }, 0);
    
    $def(self, '$call', function $$call($a) {
      var block = $$call.$$p || nil, $post_args, args, self = this;

      delete $$call.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      self.method.$$p = block;

      return self.method.apply(self.receiver, args);
    ;
    }, -1);
    
    $def(self, '$curry', function $$curry(arity) {
      var self = this;

      
      ;
      return self.method.$curry(arity);
    }, -1);
    
    $def(self, '$>>', function $Method_$gt$gt$1(other) {
      var self = this;

      return self.method['$>>'](other)
    }, 1);
    
    $def(self, '$<<', function $Method_$lt$lt$2(other) {
      var self = this;

      return self.method['$<<'](other)
    }, 1);
    
    $def(self, '$unbind', function $$unbind() {
      var self = this;

      return $$$('UnboundMethod').$new(self.receiver.$class(), self.owner, self.method, self.name)
    }, 0);
    
    $def(self, '$to_proc', function $$to_proc() {
      var self = this;

      
      var proc = self.$call.bind(self);
      proc.$$unbound = self.method;
      proc.$$is_lambda = true;
      proc.$$arity = self.method.$$arity;
      proc.$$parameters = self.method.$$parameters;
      return proc;
    
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      return "#<" + (self.$class()) + ": " + (self.receiver.$class()) + "#" + (self.name) + " (defined in " + (self.owner) + " in " + (self.$source_location().$join(":")) + ")>"
    }, 0);
    $alias(self, "[]", "call");
    return $alias(self, "===", "call");
  })('::', null);
  return (function($base, $super) {
    var self = $klass($base, $super, 'UnboundMethod');

    var $proto = self.$$prototype;

    $proto.method = $proto.owner = $proto.name = $proto.source = nil;
    
    self.$attr_reader("source", "owner", "name");
    
    $def(self, '$initialize', function $$initialize(source, owner, method, name) {
      var self = this;

      
      self.source = source;
      self.owner = owner;
      self.method = method;
      return (self.name = name);
    }, 4);
    
    $def(self, '$arity', function $$arity() {
      var self = this;

      return self.method.$arity()
    }, 0);
    
    $def(self, '$parameters', function $$parameters() {
      var self = this;

      return self.method.$$parameters
    }, 0);
    
    $def(self, '$source_location', function $$source_location() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.method.$$source_location))) {
        return $ret_or_1
      } else {
        return ["(eval)", 0]
      }
    }, 0);
    
    $def(self, '$comments', function $$comments() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.method.$$comments))) {
        return $ret_or_1
      } else {
        return []
      }
    }, 0);
    
    $def(self, '$bind', function $$bind(object) {
      var self = this;

      
      if (self.owner.$$is_module || Opal.is_a(object, self.owner)) {
        return $$$('Method').$new(object, self.owner, self.method, self.name);
      }
      else {
        $Kernel.$raise($$$('TypeError'), "can't bind singleton method to a different class (expected " + (object) + ".kind_of?(" + (self.owner) + " to be true)");
      }
    
    }, 1);
    
    $def(self, '$bind_call', function $$bind_call(object, $a) {
      var block = $$bind_call.$$p || nil, $post_args, args, self = this;

      delete $$bind_call.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      return $send(self.$bind(object), 'call', $to_a(args), block.$to_proc());
    }, -2);
    return $def(self, '$inspect', function $$inspect() {
      var self = this;

      return "#<" + (self.$class()) + ": " + (self.source) + "#" + (self.name) + " (defined in " + (self.owner) + " in " + (self.$source_location().$join(":")) + ")>"
    }, 0);
  })('::', null);
};

Opal.modules["corelib/variables"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $gvars = Opal.gvars, $const_set = Opal.const_set, $Object = Opal.Object, $hash2 = Opal.hash2;

  Opal.add_stubs('new');
  
  $gvars['&'] = $gvars['~'] = $gvars['`'] = $gvars["'"] = nil;
  $gvars.LOADED_FEATURES = ($gvars["\""] = Opal.loaded_features);
  $gvars.LOAD_PATH = ($gvars[":"] = []);
  $gvars["/"] = "\n";
  $gvars[","] = nil;
  $const_set('::', 'ARGV', []);
  $const_set('::', 'ARGF', $Object.$new());
  $const_set('::', 'ENV', $hash2([], {}));
  $gvars.VERBOSE = false;
  $gvars.DEBUG = false;
  return ($gvars.SAFE = 0);
};

Opal.modules["corelib/io"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $a, nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $const_set = Opal.const_set, $not = Opal.not, $truthy = Opal.truthy, $def = Opal.def, $return_ivar = Opal.return_ivar, $return_val = Opal.return_val, $Kernel = Opal.Kernel, $gvars = Opal.gvars, $send = Opal.send, $to_a = Opal.to_a, $rb_plus = Opal.rb_plus, $neqeq = Opal.neqeq, $range = Opal.range, $hash2 = Opal.hash2, $eqeq = Opal.eqeq, $to_ary = Opal.to_ary, $rb_gt = Opal.rb_gt, $assign_ivar_val = Opal.assign_ivar_val, $alias = Opal.alias;

  Opal.add_stubs('attr_reader,attr_accessor,!,match?,include?,size,write,String,flatten,puts,sysread_noraise,+,!=,[],ord,getc,readchar,raise,gets,==,to_str,length,split,sub,sysread,>,to_a,each_line,enum_for,getbyte,closed_write?,closed_read?,each,eof,new,write_proc=,read_proc=');
  
  (function($base, $super) {
    var self = $klass($base, $super, 'IO');

    var $proto = self.$$prototype;

    $proto.read_buffer = $proto.closed = nil;
    
    $const_set(self, 'SEEK_SET', 0);
    $const_set(self, 'SEEK_CUR', 1);
    $const_set(self, 'SEEK_END', 2);
    $const_set(self, 'SEEK_DATA', 3);
    $const_set(self, 'SEEK_HOLE', 4);
    $const_set(self, 'READABLE', 1);
    $const_set(self, 'WRITABLE', 4);
    self.$attr_reader("eof");
    self.$attr_accessor("read_proc", "sync", "tty", "write_proc");
    
    $def(self, '$initialize', function $$initialize(fd, flags) {
      var self = this;

      
      
      if (flags == null) flags = "r";;
      self.fd = fd;
      self.flags = flags;
      self.eof = false;
      if (($truthy(flags['$include?']("r")) && ($not(flags['$match?'](/[wa+]/))))) {
        return (self.closed = "write")
      } else if (($truthy(flags['$match?'](/[wa]/)) && ($not(flags['$match?'](/[r+]/))))) {
        return (self.closed = "read")
      } else {
        return nil
      };
    }, -2);
    
    $def(self, '$fileno', $return_ivar("fd"), 0);
    
    $def(self, '$tty?', function $IO_tty$ques$1() {
      var self = this;

      return self.tty == true;
    }, 0);
    
    $def(self, '$write', function $$write(string) {
      var self = this;

      
      self.write_proc(string);
      return string.$size();
    }, 1);
    
    $def(self, '$flush', $return_val(nil), 0);
    
    $def(self, '$<<', function $IO_$lt$lt$2(string) {
      var self = this;

      
      self.$write(string);
      return self;
    }, 1);
    
    $def(self, '$print', function $$print($a) {
      var $post_args, args, self = this;
      if ($gvars[","] == null) $gvars[","] = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      for (var i = 0, ii = args.length; i < ii; i++) {
        args[i] = $Kernel.$String(args[i])
      }
      self.$write(args.join($gvars[","]));
    ;
      return nil;
    }, -1);
    
    $def(self, '$puts', function $$puts($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var line
      if (args.length === 0) {
        self.$write("\n");
        return nil;
      } else {
        for (var i = 0, ii = args.length; i < ii; i++) {
          if (args[i].$$is_array){
            var ary = (args[i]).$flatten()
            if (ary.length > 0) $send(self, 'puts', $to_a((ary)))
          } else {
            if (args[i].$$is_string) {
              line = args[i].valueOf();
            } else {
              line = $Kernel.$String(args[i]);
            }
            if (!line.endsWith("\n")) line += "\n"
            self.$write(line)
          }
        }
      }
    ;
      return nil;
    }, -1);
    
    $def(self, '$getc', function $$getc() {
      var $a, self = this, $ret_or_1 = nil, parts = nil, ret = nil;

      
      self.read_buffer = ($truthy(($ret_or_1 = self.read_buffer)) ? ($ret_or_1) : (""));
      parts = "";
      do {
        
        self.read_buffer = $rb_plus(self.read_buffer, parts);
        if ($neqeq(self.read_buffer, "")) {
          
          ret = self.read_buffer['$[]'](0);
          self.read_buffer = self.read_buffer['$[]']($range(1, -1, false));
          return ret;
        };
      } while ($truthy((parts = self.$sysread_noraise(1))));;
      return nil;
    }, 0);
    
    $def(self, '$getbyte', function $$getbyte() {
      var $a, self = this;

      return ($a = self.$getc(), ($a === nil || $a == null) ? nil : self.$getc().$ord())
    }, 0);
    
    $def(self, '$readbyte', function $$readbyte() {
      var self = this;

      return self.$readchar().$ord()
    }, 0);
    
    $def(self, '$readchar', function $$readchar() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.$getc()))) {
        return $ret_or_1
      } else {
        return $Kernel.$raise($$$('EOFError'), "end of file reached")
      }
    }, 0);
    
    $def(self, '$readline', function $$readline($a) {
      var $post_args, args, self = this, $ret_or_1 = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if ($truthy(($ret_or_1 = $send(self, 'gets', $to_a(args))))) {
        return $ret_or_1
      } else {
        return $Kernel.$raise($$$('EOFError'), "end of file reached")
      };
    }, -1);
    
    $def(self, '$gets', function $$gets(sep, limit, opts) {
      var $a, $b, $c, self = this, orig_sep = nil, $ret_or_1 = nil, seplen = nil, data = nil, ret = nil, orig_buffer = nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      
      
      if (sep == null) sep = false;;
      
      if (limit == null) limit = nil;;
      
      if (opts == null) opts = $hash2([], {});;
      if (($truthy(sep.$$is_number) && ($not(limit)))) {
        $a = [false, sep, limit], (sep = $a[0]), (limit = $a[1]), (opts = $a[2]), $a
      };
      if ((($truthy(sep.$$is_hash) && ($not(limit))) && ($eqeq(opts, $hash2([], {}))))) {
        $a = [false, nil, sep], (sep = $a[0]), (limit = $a[1]), (opts = $a[2]), $a
      } else if (($truthy(limit.$$is_hash) && ($eqeq(opts, $hash2([], {}))))) {
        $a = [sep, nil, limit], (sep = $a[0]), (limit = $a[1]), (opts = $a[2]), $a
      };
      orig_sep = sep;
      if ($eqeq(sep, false)) {
        sep = $gvars["/"]
      };
      if ($eqeq(sep, "")) {
        sep = /\r?\n\r?\n/
      };
      sep = ($truthy(($ret_or_1 = sep)) ? ($ret_or_1) : (""));
      if (!$eqeq(orig_sep, "")) {
        sep = sep.$to_str()
      };
      seplen = ($eqeq(orig_sep, "") ? (2) : (sep.$length()));
      if ($eqeq(sep, " ")) {
        sep = / /
      };
      self.read_buffer = ($truthy(($ret_or_1 = self.read_buffer)) ? ($ret_or_1) : (""));
      data = "";
      ret = nil;
      do {
        
        self.read_buffer = $rb_plus(self.read_buffer, data);
        if (($neqeq(sep, "") && ($truthy(($truthy(sep.$$is_regexp) ? (self.read_buffer['$match?'](sep)) : (self.read_buffer['$include?'](sep))))))) {
          
          orig_buffer = self.read_buffer;
          $c = self.read_buffer.$split(sep, 2), $b = $to_ary($c), (ret = ($b[0] == null ? nil : $b[0])), (self.read_buffer = ($b[1] == null ? nil : $b[1])), $c;
          if ($neqeq(ret, orig_buffer)) {
            ret = $rb_plus(ret, orig_buffer['$[]'](ret.$length(), seplen))
          };
          break;;
        };
      } while ($truthy((data = self.$sysread_noraise(($eqeq(sep, "") ? (65536) : (1))))));;
      if (!$truthy(ret)) {
        
        $a = [($truthy(($ret_or_1 = self.read_buffer)) ? ($ret_or_1) : ("")), ""], (ret = $a[0]), (self.read_buffer = $a[1]), $a;
        if ($eqeq(ret, "")) {
          ret = nil
        };
      };
      if ($truthy(ret)) {
        
        if ($truthy(limit)) {
          
          ret = ret['$[]'](Opal.Range.$new(0,limit, true));
          self.read_buffer = $rb_plus(ret['$[]'](Opal.Range.$new(limit, -1, false)), self.read_buffer);
        };
        if ($truthy(opts['$[]']("chomp"))) {
          ret = ret.$sub(/\r?\n$/, "")
        };
        if ($eqeq(orig_sep, "")) {
          ret = ret.$sub(/^[\r\n]+/, "")
        };
      };
      if ($eqeq(orig_sep, false)) {
        $gvars._ = ret
      };
      return ret;
    }, -1);
    
    $def(self, '$sysread', function $$sysread(integer) {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.read_proc(integer)))) {
        return $ret_or_1
      } else {
        
        self.eof = true;
        return $Kernel.$raise($$$('EOFError'), "end of file reached");
      }
    }, 1);
    
    $def(self, '$sysread_noraise', function $$sysread_noraise(integer) {
      var self = this;

      try {
        return self.$sysread(integer)
      } catch ($err) {
        if (Opal.rescue($err, [$$$('EOFError')])) {
          try {
            return nil
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      }
    }, 1);
    
    $def(self, '$readpartial', function $$readpartial(integer) {
      var $a, self = this, $ret_or_1 = nil, part = nil, ret = nil;

      
      self.read_buffer = ($truthy(($ret_or_1 = self.read_buffer)) ? ($ret_or_1) : (""));
      part = self.$sysread(integer);
      $a = [$rb_plus(self.read_buffer, ($truthy(($ret_or_1 = part)) ? ($ret_or_1) : (""))), ""], (ret = $a[0]), (self.read_buffer = $a[1]), $a;
      if ($eqeq(ret, "")) {
        ret = nil
      };
      return ret;
    }, 1);
    
    $def(self, '$read', function $$read(integer) {
      var $a, $b, self = this, $ret_or_1 = nil, parts = nil, ret = nil;

      
      
      if (integer == null) integer = nil;;
      self.read_buffer = ($truthy(($ret_or_1 = self.read_buffer)) ? ($ret_or_1) : (""));
      parts = "";
      ret = nil;
      do {
        
        self.read_buffer = $rb_plus(self.read_buffer, parts);
        if (($truthy(integer) && ($truthy($rb_gt(self.read_buffer.$length(), integer))))) {
          
          $b = [self.read_buffer['$[]'](Opal.Range.$new(0,integer, true)), self.read_buffer['$[]'](Opal.Range.$new(integer, -1, false))], (ret = $b[0]), (self.read_buffer = $b[1]), $b;
          return ret;
        };
      } while ($truthy((parts = self.$sysread_noraise(($truthy(($ret_or_1 = integer)) ? ($ret_or_1) : (65536))))));;
      $a = [self.read_buffer, ""], (ret = $a[0]), (self.read_buffer = $a[1]), $a;
      return ret;
    }, -1);
    
    $def(self, '$readlines', function $$readlines(separator) {
      var self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      
      
      if (separator == null) separator = $gvars["/"];;
      return self.$each_line(separator).$to_a();
    }, -1);
    
    $def(self, '$each', function $$each($a, $b) {
      var block = $$each.$$p || nil, $post_args, sep, args, $c, self = this, s = nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      delete $$each.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      if ($post_args.length > 0) sep = $post_args.shift();
      if (sep == null) sep = $gvars["/"];;
      
      args = $post_args;;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each", sep].concat($to_a(args)))
      };
      while ($truthy((s = $send(self, 'gets', [sep].concat($to_a(args)))))) {
        Opal.yield1(block, s)
      };
      return self;
    }, -1);
    
    $def(self, '$each_byte', function $$each_byte() {
      var block = $$each_byte.$$p || nil, $a, self = this, s = nil;

      delete $$each_byte.$$p;
      
      ;
      if (!(block !== nil)) {
        return self.$enum_for("each_byte")
      };
      while ($truthy((s = self.$getbyte()))) {
        Opal.yield1(block, s)
      };
      return self;
    }, 0);
    
    $def(self, '$each_char', function $$each_char() {
      var block = $$each_char.$$p || nil, $a, self = this, s = nil;

      delete $$each_char.$$p;
      
      ;
      if (!(block !== nil)) {
        return self.$enum_for("each_char")
      };
      while ($truthy((s = self.$getc()))) {
        Opal.yield1(block, s)
      };
      return self;
    }, 0);
    
    $def(self, '$close', $assign_ivar_val("closed", "both"), 0);
    
    $def(self, '$close_read', function $$close_read() {
      var self = this;

      if ($eqeq(self.closed, "write")) {
        return (self.closed = "both")
      } else {
        return (self.closed = "read")
      }
    }, 0);
    
    $def(self, '$close_write', function $$close_write() {
      var self = this;

      if ($eqeq(self.closed, "read")) {
        return (self.closed = "both")
      } else {
        return (self.closed = "write")
      }
    }, 0);
    
    $def(self, '$closed?', function $IO_closed$ques$3() {
      var self = this;

      return self.closed['$==']("both")
    }, 0);
    
    $def(self, '$closed_read?', function $IO_closed_read$ques$4() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.closed['$==']("read")))) {
        return $ret_or_1
      } else {
        return self.closed['$==']("both")
      }
    }, 0);
    
    $def(self, '$closed_write?', function $IO_closed_write$ques$5() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.closed['$==']("write")))) {
        return $ret_or_1
      } else {
        return self.closed['$==']("both")
      }
    }, 0);
    
    $def(self, '$check_writable', function $$check_writable() {
      var self = this;

      if ($truthy(self['$closed_write?']())) {
        return $Kernel.$raise($$$('IOError'), "not opened for writing")
      } else {
        return nil
      }
    }, 0);
    
    $def(self, '$check_readable', function $$check_readable() {
      var self = this;

      if ($truthy(self['$closed_read?']())) {
        return $Kernel.$raise($$$('IOError'), "not opened for reading")
      } else {
        return nil
      }
    }, 0);
    $alias(self, "each_line", "each");
    return $alias(self, "eof?", "eof");
  })('::', null);
  $const_set('::', 'STDIN', ($gvars.stdin = $$$('IO').$new(0, "r")));
  $const_set('::', 'STDOUT', ($gvars.stdout = $$$('IO').$new(1, "w")));
  $const_set('::', 'STDERR', ($gvars.stderr = $$$('IO').$new(2, "w")));
  var console = Opal.global.console;
  $$$('STDOUT')['$write_proc='](typeof(process) === 'object' && typeof(process.stdout) === 'object' ? function(s){process.stdout.write(s)} : function(s){console.log(s)});
  $$$('STDERR')['$write_proc='](typeof(process) === 'object' && typeof(process.stderr) === 'object' ? function(s){process.stderr.write(s)} : function(s){console.warn(s)});
  return ($a = [function(s) { var p = prompt(); if (p !== null) return p + "\n"; return nil; }], $send($$$('STDIN'), 'read_proc=', $a), $a[$a.length - 1]);
};

Opal.modules["opal/regexp_anchors"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $const_set = Opal.const_set;

  Opal.add_stubs('new');
  return (function($base, $parent_nesting) {
    var self = $module($base, 'Opal');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    $const_set(self, 'REGEXP_START', "^");
    $const_set(self, 'REGEXP_END', "$");
    $const_set(self, 'FORBIDDEN_STARTING_IDENTIFIER_CHARS', "\\u0001-\\u002F\\u003A-\\u0040\\u005B-\\u005E\\u0060\\u007B-\\u007F");
    $const_set(self, 'FORBIDDEN_ENDING_IDENTIFIER_CHARS', "\\u0001-\\u0020\\u0022-\\u002F\\u003A-\\u003E\\u0040\\u005B-\\u005E\\u0060\\u007B-\\u007F");
    $const_set(self, 'INLINE_IDENTIFIER_REGEXP', $$('Regexp').$new("[^" + ($$$(self, 'FORBIDDEN_STARTING_IDENTIFIER_CHARS')) + "]*[^" + ($$$(self, 'FORBIDDEN_ENDING_IDENTIFIER_CHARS')) + "]"));
    $const_set(self, 'FORBIDDEN_CONST_NAME_CHARS', "\\u0001-\\u0020\\u0021-\\u002F\\u003B-\\u003F\\u0040\\u005B-\\u005E\\u0060\\u007B-\\u007F");
    return $const_set(self, 'CONST_NAME_REGEXP', $$('Regexp').$new("" + ($$$(self, 'REGEXP_START')) + "(::)?[A-Z][^" + ($$$(self, 'FORBIDDEN_CONST_NAME_CHARS')) + "]*" + ($$$(self, 'REGEXP_END'))));
  })($nesting[0], $nesting)
};

Opal.modules["opal/mini"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $Object = Opal.Object;

  Opal.add_stubs('require');
  
  $Object.$require("opal/base");
  $Object.$require("corelib/nil");
  $Object.$require("corelib/boolean");
  $Object.$require("corelib/string");
  $Object.$require("corelib/comparable");
  $Object.$require("corelib/enumerable");
  $Object.$require("corelib/enumerator");
  $Object.$require("corelib/array");
  $Object.$require("corelib/hash");
  $Object.$require("corelib/number");
  $Object.$require("corelib/range");
  $Object.$require("corelib/proc");
  $Object.$require("corelib/method");
  $Object.$require("corelib/regexp");
  $Object.$require("corelib/variables");
  $Object.$require("corelib/io");
  return $Object.$require("opal/regexp_anchors");
};

Opal.modules["corelib/kernel/format"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $coerce_to = Opal.coerce_to, $module = Opal.module, $truthy = Opal.truthy, $eqeq = Opal.eqeq, $Opal = Opal.Opal, $Kernel = Opal.Kernel, $gvars = Opal.gvars, $def = Opal.def, $alias = Opal.alias;

  Opal.add_stubs('respond_to?,[],==,length,coerce_to?,nil?,to_a,raise,to_int,fetch,Integer,Float,to_ary,to_str,inspect,to_s,format');
  return (function($base) {
    var self = $module($base, 'Kernel');

    
    
    
    $def(self, '$format', function $$format(format_string, $a) {
      var $post_args, args, ary = nil;
      if ($gvars.DEBUG == null) $gvars.DEBUG = nil;

      
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      if (($eqeq(args.$length(), 1) && ($truthy(args['$[]'](0)['$respond_to?']("to_ary"))))) {
        
        ary = $Opal['$coerce_to?'](args['$[]'](0), $$$('Array'), "to_ary");
        if (!$truthy(ary['$nil?']())) {
          args = ary.$to_a()
        };
      };
      
      var result = '',
          //used for slicing:
          begin_slice = 0,
          end_slice,
          //used for iterating over the format string:
          i,
          len = format_string.length,
          //used for processing field values:
          arg,
          str,
          //used for processing %g and %G fields:
          exponent,
          //used for keeping track of width and precision:
          width,
          precision,
          //used for holding temporary values:
          tmp_num,
          //used for processing %{} and %<> fileds:
          hash_parameter_key,
          closing_brace_char,
          //used for processing %b, %B, %o, %x, and %X fields:
          base_number,
          base_prefix,
          base_neg_zero_regex,
          base_neg_zero_digit,
          //used for processing arguments:
          next_arg,
          seq_arg_num = 1,
          pos_arg_num = 0,
          //used for keeping track of flags:
          flags,
          FNONE  = 0,
          FSHARP = 1,
          FMINUS = 2,
          FPLUS  = 4,
          FZERO  = 8,
          FSPACE = 16,
          FWIDTH = 32,
          FPREC  = 64,
          FPREC0 = 128;

      function CHECK_FOR_FLAGS() {
        if (flags&FWIDTH) { $Kernel.$raise($$$('ArgumentError'), "flag after width") }
        if (flags&FPREC0) { $Kernel.$raise($$$('ArgumentError'), "flag after precision") }
      }

      function CHECK_FOR_WIDTH() {
        if (flags&FWIDTH) { $Kernel.$raise($$$('ArgumentError'), "width given twice") }
        if (flags&FPREC0) { $Kernel.$raise($$$('ArgumentError'), "width after precision") }
      }

      function GET_NTH_ARG(num) {
        if (num >= args.length) { $Kernel.$raise($$$('ArgumentError'), "too few arguments") }
        return args[num];
      }

      function GET_NEXT_ARG() {
        switch (pos_arg_num) {
        case -1: $Kernel.$raise($$$('ArgumentError'), "unnumbered(" + (seq_arg_num) + ") mixed with numbered") // raise
        case -2: $Kernel.$raise($$$('ArgumentError'), "unnumbered(" + (seq_arg_num) + ") mixed with named") // raise
        }
        pos_arg_num = seq_arg_num++;
        return GET_NTH_ARG(pos_arg_num - 1);
      }

      function GET_POS_ARG(num) {
        if (pos_arg_num > 0) {
          $Kernel.$raise($$$('ArgumentError'), "numbered(" + (num) + ") after unnumbered(" + (pos_arg_num) + ")")
        }
        if (pos_arg_num === -2) {
          $Kernel.$raise($$$('ArgumentError'), "numbered(" + (num) + ") after named")
        }
        if (num < 1) {
          $Kernel.$raise($$$('ArgumentError'), "invalid index - " + (num) + "$")
        }
        pos_arg_num = -1;
        return GET_NTH_ARG(num - 1);
      }

      function GET_ARG() {
        return (next_arg === undefined ? GET_NEXT_ARG() : next_arg);
      }

      function READ_NUM(label) {
        var num, str = '';
        for (;; i++) {
          if (i === len) {
            $Kernel.$raise($$$('ArgumentError'), "malformed format string - %*[0-9]")
          }
          if (format_string.charCodeAt(i) < 48 || format_string.charCodeAt(i) > 57) {
            i--;
            num = parseInt(str, 10) || 0;
            if (num > 2147483647) {
              $Kernel.$raise($$$('ArgumentError'), "" + (label) + " too big")
            }
            return num;
          }
          str += format_string.charAt(i);
        }
      }

      function READ_NUM_AFTER_ASTER(label) {
        var arg, num = READ_NUM(label);
        if (format_string.charAt(i + 1) === '$') {
          i++;
          arg = GET_POS_ARG(num);
        } else {
          arg = GET_NEXT_ARG();
        }
        return (arg).$to_int();
      }

      for (i = format_string.indexOf('%'); i !== -1; i = format_string.indexOf('%', i)) {
        str = undefined;

        flags = FNONE;
        width = -1;
        precision = -1;
        next_arg = undefined;

        end_slice = i;

        i++;

        switch (format_string.charAt(i)) {
        case '%':
          begin_slice = i;
          // no-break
        case '':
        case '\n':
        case '\0':
          i++;
          continue;
        }

        format_sequence: for (; i < len; i++) {
          switch (format_string.charAt(i)) {

          case ' ':
            CHECK_FOR_FLAGS();
            flags |= FSPACE;
            continue format_sequence;

          case '#':
            CHECK_FOR_FLAGS();
            flags |= FSHARP;
            continue format_sequence;

          case '+':
            CHECK_FOR_FLAGS();
            flags |= FPLUS;
            continue format_sequence;

          case '-':
            CHECK_FOR_FLAGS();
            flags |= FMINUS;
            continue format_sequence;

          case '0':
            CHECK_FOR_FLAGS();
            flags |= FZERO;
            continue format_sequence;

          case '1':
          case '2':
          case '3':
          case '4':
          case '5':
          case '6':
          case '7':
          case '8':
          case '9':
            tmp_num = READ_NUM('width');
            if (format_string.charAt(i + 1) === '$') {
              if (i + 2 === len) {
                str = '%';
                i++;
                break format_sequence;
              }
              if (next_arg !== undefined) {
                $Kernel.$raise($$$('ArgumentError'), "value given twice - %" + (tmp_num) + "$")
              }
              next_arg = GET_POS_ARG(tmp_num);
              i++;
            } else {
              CHECK_FOR_WIDTH();
              flags |= FWIDTH;
              width = tmp_num;
            }
            continue format_sequence;

          case '<':
          case '\{':
            closing_brace_char = (format_string.charAt(i) === '<' ? '>' : '\}');
            hash_parameter_key = '';

            i++;

            for (;; i++) {
              if (i === len) {
                $Kernel.$raise($$$('ArgumentError'), "malformed name - unmatched parenthesis")
              }
              if (format_string.charAt(i) === closing_brace_char) {

                if (pos_arg_num > 0) {
                  $Kernel.$raise($$$('ArgumentError'), "named " + (hash_parameter_key) + " after unnumbered(" + (pos_arg_num) + ")")
                }
                if (pos_arg_num === -1) {
                  $Kernel.$raise($$$('ArgumentError'), "named " + (hash_parameter_key) + " after numbered")
                }
                pos_arg_num = -2;

                if (args[0] === undefined || !args[0].$$is_hash) {
                  $Kernel.$raise($$$('ArgumentError'), "one hash required")
                }

                next_arg = (args[0]).$fetch(hash_parameter_key);

                if (closing_brace_char === '>') {
                  continue format_sequence;
                } else {
                  str = next_arg.toString();
                  if (precision !== -1) { str = str.slice(0, precision); }
                  if (flags&FMINUS) {
                    while (str.length < width) { str = str + ' '; }
                  } else {
                    while (str.length < width) { str = ' ' + str; }
                  }
                  break format_sequence;
                }
              }
              hash_parameter_key += format_string.charAt(i);
            }
            // raise

          case '*':
            i++;
            CHECK_FOR_WIDTH();
            flags |= FWIDTH;
            width = READ_NUM_AFTER_ASTER('width');
            if (width < 0) {
              flags |= FMINUS;
              width = -width;
            }
            continue format_sequence;

          case '.':
            if (flags&FPREC0) {
              $Kernel.$raise($$$('ArgumentError'), "precision given twice")
            }
            flags |= FPREC|FPREC0;
            precision = 0;
            i++;
            if (format_string.charAt(i) === '*') {
              i++;
              precision = READ_NUM_AFTER_ASTER('precision');
              if (precision < 0) {
                flags &= ~FPREC;
              }
              continue format_sequence;
            }
            precision = READ_NUM('precision');
            continue format_sequence;

          case 'd':
          case 'i':
          case 'u':
            arg = $Kernel.$Integer(GET_ARG());
            if (arg >= 0) {
              str = arg.toString();
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0)) { str = '0' + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              str = (-arg).toString();
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                str = '-' + str;
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - 1) { str = '0' + str; }
                  str = '-' + str;
                } else {
                  str = '-' + str;
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            }
            break format_sequence;

          case 'b':
          case 'B':
          case 'o':
          case 'x':
          case 'X':
            switch (format_string.charAt(i)) {
            case 'b':
            case 'B':
              base_number = 2;
              base_prefix = '0b';
              base_neg_zero_regex = /^1+/;
              base_neg_zero_digit = '1';
              break;
            case 'o':
              base_number = 8;
              base_prefix = '0';
              base_neg_zero_regex = /^3?7+/;
              base_neg_zero_digit = '7';
              break;
            case 'x':
            case 'X':
              base_number = 16;
              base_prefix = '0x';
              base_neg_zero_regex = /^f+/;
              base_neg_zero_digit = 'f';
              break;
            }
            arg = $Kernel.$Integer(GET_ARG());
            if (arg >= 0) {
              str = arg.toString(base_number);
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0) - ((flags&FSHARP && arg !== 0) ? base_prefix.length : 0)) { str = '0' + str; }
                  if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              if (flags&FPLUS || flags&FSPACE) {
                str = (-arg).toString(base_number);
                while (str.length < precision) { str = '0' + str; }
                if (flags&FMINUS) {
                  if (flags&FSHARP) { str = base_prefix + str; }
                  str = '-' + str;
                  while (str.length < width) { str = str + ' '; }
                } else {
                  if (flags&FZERO && precision === -1) {
                    while (str.length < width - 1 - (flags&FSHARP ? 2 : 0)) { str = '0' + str; }
                    if (flags&FSHARP) { str = base_prefix + str; }
                    str = '-' + str;
                  } else {
                    if (flags&FSHARP) { str = base_prefix + str; }
                    str = '-' + str;
                    while (str.length < width) { str = ' ' + str; }
                  }
                }
              } else {
                str = (arg >>> 0).toString(base_number).replace(base_neg_zero_regex, base_neg_zero_digit);
                while (str.length < precision - 2) { str = base_neg_zero_digit + str; }
                if (flags&FMINUS) {
                  str = '..' + str;
                  if (flags&FSHARP) { str = base_prefix + str; }
                  while (str.length < width) { str = str + ' '; }
                } else {
                  if (flags&FZERO && precision === -1) {
                    while (str.length < width - 2 - (flags&FSHARP ? base_prefix.length : 0)) { str = base_neg_zero_digit + str; }
                    str = '..' + str;
                    if (flags&FSHARP) { str = base_prefix + str; }
                  } else {
                    str = '..' + str;
                    if (flags&FSHARP) { str = base_prefix + str; }
                    while (str.length < width) { str = ' ' + str; }
                  }
                }
              }
            }
            if (format_string.charAt(i) === format_string.charAt(i).toUpperCase()) {
              str = str.toUpperCase();
            }
            break format_sequence;

          case 'f':
          case 'e':
          case 'E':
          case 'g':
          case 'G':
            arg = $Kernel.$Float(GET_ARG());
            if (arg >= 0 || isNaN(arg)) {
              if (arg === Infinity) {
                str = 'Inf';
              } else {
                switch (format_string.charAt(i)) {
                case 'f':
                  str = arg.toFixed(precision === -1 ? 6 : precision);
                  break;
                case 'e':
                case 'E':
                  str = arg.toExponential(precision === -1 ? 6 : precision);
                  break;
                case 'g':
                case 'G':
                  str = arg.toExponential();
                  exponent = parseInt(str.split('e')[1], 10);
                  if (!(exponent < -4 || exponent >= (precision === -1 ? 6 : precision))) {
                    str = arg.toPrecision(precision === -1 ? (flags&FSHARP ? 6 : undefined) : precision);
                  }
                  break;
                }
              }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && arg !== Infinity && !isNaN(arg)) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0)) { str = '0' + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              if (arg === -Infinity) {
                str = 'Inf';
              } else {
                switch (format_string.charAt(i)) {
                case 'f':
                  str = (-arg).toFixed(precision === -1 ? 6 : precision);
                  break;
                case 'e':
                case 'E':
                  str = (-arg).toExponential(precision === -1 ? 6 : precision);
                  break;
                case 'g':
                case 'G':
                  str = (-arg).toExponential();
                  exponent = parseInt(str.split('e')[1], 10);
                  if (!(exponent < -4 || exponent >= (precision === -1 ? 6 : precision))) {
                    str = (-arg).toPrecision(precision === -1 ? (flags&FSHARP ? 6 : undefined) : precision);
                  }
                  break;
                }
              }
              if (flags&FMINUS) {
                str = '-' + str;
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && arg !== -Infinity) {
                  while (str.length < width - 1) { str = '0' + str; }
                  str = '-' + str;
                } else {
                  str = '-' + str;
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            }
            if (format_string.charAt(i) === format_string.charAt(i).toUpperCase() && arg !== Infinity && arg !== -Infinity && !isNaN(arg)) {
              str = str.toUpperCase();
            }
            str = str.replace(/([eE][-+]?)([0-9])$/, '$10$2');
            break format_sequence;

          case 'a':
          case 'A':
            // Not implemented because there are no specs for this field type.
            $Kernel.$raise($$$('NotImplementedError'), "`A` and `a` format field types are not implemented in Opal yet")
            // raise

          case 'c':
            arg = GET_ARG();
            if ((arg)['$respond_to?']("to_ary")) { arg = (arg).$to_ary()[0]; }
            if ((arg)['$respond_to?']("to_str")) {
              str = (arg).$to_str();
            } else {
              str = String.fromCharCode($coerce_to(arg, $$$('Integer'), 'to_int'));
            }
            if (str.length !== 1) {
              $Kernel.$raise($$$('ArgumentError'), "%c requires a character")
            }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          case 'p':
            str = (GET_ARG()).$inspect();
            if (precision !== -1) { str = str.slice(0, precision); }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          case 's':
            str = (GET_ARG()).$to_s();
            if (precision !== -1) { str = str.slice(0, precision); }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          default:
            $Kernel.$raise($$$('ArgumentError'), "malformed format string - %" + (format_string.charAt(i)))
          }
        }

        if (str === undefined) {
          $Kernel.$raise($$$('ArgumentError'), "malformed format string - %")
        }

        result += format_string.slice(begin_slice, end_slice) + str;
        begin_slice = i + 1;
      }

      if ($gvars.DEBUG && pos_arg_num >= 0 && seq_arg_num < args.length) {
        $Kernel.$raise($$$('ArgumentError'), "too many arguments for format string")
      }

      return result + format_string.slice(begin_slice);
    ;
    }, -2);
    return $alias(self, "sprintf", "format");
  })('::')
};

Opal.modules["corelib/string/encoding"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $a, self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $hash2 = Opal.hash2, $rb_plus = Opal.rb_plus, $truthy = Opal.truthy, $send = Opal.send, $defs = Opal.defs, $eqeq = Opal.eqeq, $def = Opal.def, $return_ivar = Opal.return_ivar, $return_val = Opal.return_val, $Kernel = Opal.Kernel, $Opal = Opal.Opal, $rb_lt = Opal.rb_lt, $alias = Opal.alias;

  Opal.add_stubs('require,+,[],clone,initialize,new,instance_eval,to_proc,each,const_set,tr,==,default_external,attr_accessor,singleton_class,attr_reader,raise,register,length,bytes,force_encoding,dup,bytesize,enum_for,each_byte,to_a,each_char,each_codepoint,coerce_to!,find,<,default_external=');
  
  self.$require("corelib/string");
  (function($base, $super) {
    var self = $klass($base, $super, 'Encoding');

    var $proto = self.$$prototype;

    $proto.name = $proto.dummy = nil;
    
    $defs(self, '$register', function $$register(name, options) {
      var block = $$register.$$p || nil, self = this, names = nil, $ret_or_1 = nil, ascii = nil, dummy = nil, encoding = nil, register = nil;

      delete $$register.$$p;
      
      ;
      
      if (options == null) options = $hash2([], {});;
      names = $rb_plus([name], ($truthy(($ret_or_1 = options['$[]']("aliases"))) ? ($ret_or_1) : ([])));
      ascii = ($truthy(($ret_or_1 = options['$[]']("ascii"))) && ($ret_or_1));
      dummy = ($truthy(($ret_or_1 = options['$[]']("dummy"))) && ($ret_or_1));
      if ($truthy(options['$[]']("inherits"))) {
        
        encoding = options['$[]']("inherits").$clone();
        encoding.$initialize(name, names, ascii, dummy);
      } else {
        encoding = self.$new(name, names, ascii, dummy)
      };
      if ((block !== nil)) {
        $send(encoding, 'instance_eval', [], block.$to_proc())
      };
      register = Opal.encodings;
      return $send(names, 'each', [], function $$1(encoding_name){var self = $$1.$$s == null ? this : $$1.$$s;

        
        
        if (encoding_name == null) encoding_name = nil;;
        self.$const_set(encoding_name.$tr("-", "_"), encoding);
        return register[encoding_name] = encoding;}, {$$arity: 1, $$s: self});
    }, -2);
    $defs(self, '$find', function $$find(name) {
      var self = this;

      
      if ($eqeq(name, "default_external")) {
        return self.$default_external()
      };
      return Opal.find_encoding(name);;
    }, 1);
    self.$singleton_class().$attr_accessor("default_external");
    self.$attr_reader("name", "names");
    
    $def(self, '$initialize', function $$initialize(name, names, ascii, dummy) {
      var self = this;

      
      self.name = name;
      self.names = names;
      self.ascii = ascii;
      return (self.dummy = dummy);
    }, 4);
    
    $def(self, '$ascii_compatible?', $return_ivar("ascii"), 0);
    
    $def(self, '$dummy?', $return_ivar("dummy"), 0);
    
    $def(self, '$binary?', $return_val(false), 0);
    
    $def(self, '$to_s', $return_ivar("name"), 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      return "#<Encoding:" + (self.name) + (($truthy(self.dummy) ? (" (dummy)") : nil)) + ">"
    }, 0);
    
    $def(self, '$charsize', function $$charsize(string) {
      
      
      var len = 0;
      for (var i = 0, length = string.length; i < length; i++) {
        var charcode = string.charCodeAt(i);
        if (!(charcode >= 0xD800 && charcode <= 0xDBFF)) {
          len++;
        }
      }
      return len;
    
    }, 1);
    
    $def(self, '$each_char', function $$each_char(string) {
      var block = $$each_char.$$p || nil;

      delete $$each_char.$$p;
      
      ;
      
      var low_surrogate = "";
      for (var i = 0, length = string.length; i < length; i++) {
        var charcode = string.charCodeAt(i);
        var chr = string.charAt(i);
        if (charcode >= 0xDC00 && charcode <= 0xDFFF) {
          low_surrogate = chr;
          continue;
        }
        else if (charcode >= 0xD800 && charcode <= 0xDBFF) {
          chr = low_surrogate + chr;
        }
        if (string.encoding.name != "UTF-8") {
          chr = new String(chr);
          chr.encoding = string.encoding;
        }
        Opal.yield1(block, chr);
      }
    ;
    }, 1);
    
    $def(self, '$each_byte', function $$each_byte($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return $Kernel.$raise($$$('NotImplementedError'));
    }, -1);
    
    $def(self, '$bytesize', function $$bytesize($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return $Kernel.$raise($$$('NotImplementedError'));
    }, -1);
    $klass('::', $$$('StandardError'), 'EncodingError');
    return ($klass('::', $$$('EncodingError'), 'CompatibilityError'), nil);
  })('::', null);
  $send($$$('Encoding'), 'register', ["UTF-8", $hash2(["aliases", "ascii"], {"aliases": ["CP65001"], "ascii": true})], function $$2(){var self = $$2.$$s == null ? this : $$2.$$s;

    
    
    $def(self, '$each_byte', function $$each_byte(string) {
      var block = $$each_byte.$$p || nil;

      delete $$each_byte.$$p;
      
      ;
      
      // Taken from: https://github.com/feross/buffer/blob/f52dffd9df0445b93c0c9065c2f8f0f46b2c729a/index.js#L1954-L2032
      var units = Infinity;
      var codePoint;
      var length = string.length;
      var leadSurrogate = null;

      for (var i = 0; i < length; ++i) {
        codePoint = string.charCodeAt(i);

        // is surrogate component
        if (codePoint > 0xD7FF && codePoint < 0xE000) {
          // last char was a lead
          if (!leadSurrogate) {
            // no lead yet
            if (codePoint > 0xDBFF) {
              // unexpected trail
              if ((units -= 3) > -1) {
                Opal.yield1(block, 0xEF);
                Opal.yield1(block, 0xBF);
                Opal.yield1(block, 0xBD);
              }
              continue;
            } else if (i + 1 === length) {
              // unpaired lead
              if ((units -= 3) > -1) {
                Opal.yield1(block, 0xEF);
                Opal.yield1(block, 0xBF);
                Opal.yield1(block, 0xBD);
              }
              continue;
            }

            // valid lead
            leadSurrogate = codePoint;

            continue;
          }

          // 2 leads in a row
          if (codePoint < 0xDC00) {
            if ((units -= 3) > -1) {
              Opal.yield1(block, 0xEF);
              Opal.yield1(block, 0xBF);
              Opal.yield1(block, 0xBD);
            }
            leadSurrogate = codePoint;
            continue;
          }

          // valid surrogate pair
          codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000;
        } else if (leadSurrogate) {
          // valid bmp char, but last char was a lead
          if ((units -= 3) > -1) {
            Opal.yield1(block, 0xEF);
            Opal.yield1(block, 0xBF);
            Opal.yield1(block, 0xBD);
          }
        }

        leadSurrogate = null;

        // encode utf8
        if (codePoint < 0x80) {
          if ((units -= 1) < 0) break;
          Opal.yield1(block, codePoint);
        } else if (codePoint < 0x800) {
          if ((units -= 2) < 0) break;
          Opal.yield1(block, codePoint >> 0x6 | 0xC0);
          Opal.yield1(block, codePoint & 0x3F | 0x80);
        } else if (codePoint < 0x10000) {
          if ((units -= 3) < 0) break;
          Opal.yield1(block, codePoint >> 0xC | 0xE0);
          Opal.yield1(block, codePoint >> 0x6 & 0x3F | 0x80);
          Opal.yield1(block, codePoint & 0x3F | 0x80);
        } else if (codePoint < 0x110000) {
          if ((units -= 4) < 0) break;
          Opal.yield1(block, codePoint >> 0x12 | 0xF0);
          Opal.yield1(block, codePoint >> 0xC & 0x3F | 0x80);
          Opal.yield1(block, codePoint >> 0x6 & 0x3F | 0x80);
          Opal.yield1(block, codePoint & 0x3F | 0x80);
        } else {
          // Invalid code point
        }
      }
    ;
    }, 1);
    return $def(self, '$bytesize', function $$bytesize(string) {
      
      return string.$bytes().$length()
    }, 1);}, {$$arity: 0, $$s: self});
  $send($$$('Encoding'), 'register', ["UTF-16LE"], function $$3(){var self = $$3.$$s == null ? this : $$3.$$s;

    
    
    $def(self, '$each_byte', function $$each_byte(string) {
      var block = $$each_byte.$$p || nil;

      delete $$each_byte.$$p;
      
      ;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var code = string.charCodeAt(i);

        Opal.yield1(block, code & 0xff);
        Opal.yield1(block, code >> 8);
      }
    ;
    }, 1);
    return $def(self, '$bytesize', function $$bytesize(string) {
      
      return string.length * 2;
    }, 1);}, {$$arity: 0, $$s: self});
  $send($$$('Encoding'), 'register', ["UTF-16BE", $hash2(["inherits"], {"inherits": $$$($$$('Encoding'), 'UTF_16LE')})], function $$4(){var self = $$4.$$s == null ? this : $$4.$$s;

    return $def(self, '$each_byte', function $$each_byte(string) {
      var block = $$each_byte.$$p || nil;

      delete $$each_byte.$$p;
      
      ;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var code = string.charCodeAt(i);

        Opal.yield1(block, code >> 8);
        Opal.yield1(block, code & 0xff);
      }
    ;
    }, 1)}, {$$arity: 0, $$s: self});
  $send($$$('Encoding'), 'register', ["UTF-32LE"], function $$5(){var self = $$5.$$s == null ? this : $$5.$$s;

    
    
    $def(self, '$each_byte', function $$each_byte(string) {
      var block = $$each_byte.$$p || nil;

      delete $$each_byte.$$p;
      
      ;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var code = string.charCodeAt(i);

        Opal.yield1(block, code & 0xff);
        Opal.yield1(block, code >> 8);
        Opal.yield1(block, 0);
        Opal.yield1(block, 0);
      }
    ;
    }, 1);
    return $def(self, '$bytesize', function $$bytesize(string) {
      
      return string.length * 4;
    }, 1);}, {$$arity: 0, $$s: self});
  $send($$$('Encoding'), 'register', ["UTF-32BE", $hash2(["inherits"], {"inherits": $$$($$$('Encoding'), 'UTF_32LE')})], function $$6(){var self = $$6.$$s == null ? this : $$6.$$s;

    return $def(self, '$each_byte', function $$each_byte(string) {
      var block = $$each_byte.$$p || nil;

      delete $$each_byte.$$p;
      
      ;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var code = string.charCodeAt(i);

        Opal.yield1(block, 0);
        Opal.yield1(block, 0);
        Opal.yield1(block, code >> 8);
        Opal.yield1(block, code & 0xff);
      }
    ;
    }, 1)}, {$$arity: 0, $$s: self});
  $send($$$('Encoding'), 'register', ["ASCII-8BIT", $hash2(["aliases", "ascii"], {"aliases": ["BINARY"], "ascii": true})], function $$7(){var self = $$7.$$s == null ? this : $$7.$$s;

    
    
    $def(self, '$each_char', function $$each_char(string) {
      var block = $$each_char.$$p || nil;

      delete $$each_char.$$p;
      
      ;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var chr = new String(string.charAt(i));
        chr.encoding = string.encoding;
        Opal.yield1(block, chr);
      }
    ;
    }, 1);
    
    $def(self, '$charsize', function $$charsize(string) {
      
      return string.length;
    }, 1);
    
    $def(self, '$each_byte', function $$each_byte(string) {
      var block = $$each_byte.$$p || nil;

      delete $$each_byte.$$p;
      
      ;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var code = string.charCodeAt(i);
        Opal.yield1(block, code & 0xff);
      }
    ;
    }, 1);
    
    $def(self, '$bytesize', function $$bytesize(string) {
      
      return string.length;
    }, 1);
    return $def(self, '$binary?', $return_val(true), 0);}, {$$arity: 0, $$s: self});
  $$$('Encoding').$register("ISO-8859-1", $hash2(["aliases", "ascii", "inherits"], {"aliases": ["ISO8859-1"], "ascii": true, "inherits": $$$($$$('Encoding'), 'ASCII_8BIT')}));
  $$$('Encoding').$register("US-ASCII", $hash2(["aliases", "ascii", "inherits"], {"aliases": ["ASCII"], "ascii": true, "inherits": $$$($$$('Encoding'), 'ASCII_8BIT')}));
  (function($base, $super) {
    var self = $klass($base, $super, 'String');

    var $proto = self.$$prototype;

    $proto.internal_encoding = $proto.bytes = $proto.encoding = nil;
    
    self.$attr_reader("encoding");
    self.$attr_reader("internal_encoding");
    Opal.prop(String.prototype, 'bytes', nil);
    Opal.prop(String.prototype, 'encoding', $$$($$$('Encoding'), 'UTF_8'));
    Opal.prop(String.prototype, 'internal_encoding', $$$($$$('Encoding'), 'UTF_8'));
    
    $def(self, '$b', function $$b() {
      var self = this;

      return self.$dup().$force_encoding("binary")
    }, 0);
    
    $def(self, '$bytesize', function $$bytesize() {
      var self = this;

      return self.internal_encoding.$bytesize(self)
    }, 0);
    
    $def(self, '$each_byte', function $$each_byte() {
      var block = $$each_byte.$$p || nil, self = this;

      delete $$each_byte.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_byte"], function $$8(){var self = $$8.$$s == null ? this : $$8.$$s;

          return self.$bytesize()}, {$$arity: 0, $$s: self})
      };
      $send(self.internal_encoding, 'each_byte', [self], block.$to_proc());
      return self;
    }, 0);
    
    $def(self, '$bytes', function $$bytes() {
      var self = this, $ret_or_1 = nil;

      
      
      if (typeof self === 'string') {
        return (new String(self)).$each_byte().$to_a();
      }
    ;
      self.bytes = ($truthy(($ret_or_1 = self.bytes)) ? ($ret_or_1) : (self.$each_byte().$to_a()));
      return self.bytes.$dup();
    }, 0);
    
    $def(self, '$each_char', function $$each_char() {
      var block = $$each_char.$$p || nil, self = this;

      delete $$each_char.$$p;
      
      ;
      if (!(block !== nil)) {
        return $send(self, 'enum_for', ["each_char"], function $$9(){var self = $$9.$$s == null ? this : $$9.$$s;

          return self.$length()}, {$$arity: 0, $$s: self})
      };
      $send(self.encoding, 'each_char', [self], block.$to_proc());
      return self;
    }, 0);
    
    $def(self, '$chars', function $$chars() {
      var block = $$chars.$$p || nil, self = this;

      delete $$chars.$$p;
      
      ;
      if (!$truthy(block)) {
        return self.$each_char().$to_a()
      };
      return $send(self, 'each_char', [], block.$to_proc());
    }, 0);
    
    $def(self, '$each_codepoint', function $$each_codepoint() {
      var block = $$each_codepoint.$$p || nil, self = this;

      delete $$each_codepoint.$$p;
      
      ;
      if (!(block !== nil)) {
        return self.$enum_for("each_codepoint")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        Opal.yield1(block, self.codePointAt(i));
      }
    ;
      return self;
    }, 0);
    
    $def(self, '$codepoints', function $$codepoints() {
      var block = $$codepoints.$$p || nil, self = this;

      delete $$codepoints.$$p;
      
      ;
      if ((block !== nil)) {
        return $send(self, 'each_codepoint', [], block.$to_proc())
      };
      return self.$each_codepoint().$to_a();
    }, 0);
    
    $def(self, '$encode', function $$encode(encoding) {
      var self = this;

      return Opal.enc(self, encoding);
    }, 1);
    
    $def(self, '$force_encoding', function $$force_encoding(encoding) {
      var self = this;

      
      var str = self;

      if (encoding === str.encoding) { return str; }

      encoding = $Opal['$coerce_to!'](encoding, $$$('String'), "to_s");
      encoding = $$$('Encoding').$find(encoding);

      if (encoding === str.encoding) { return str; }

      str = Opal.set_encoding(str, encoding);

      return str;
    
    }, 1);
    
    $def(self, '$getbyte', function $$getbyte(idx) {
      var self = this, string_bytes = nil;

      
      string_bytes = self.$bytes();
      idx = $Opal['$coerce_to!'](idx, $$$('Integer'), "to_int");
      if ($truthy($rb_lt(string_bytes.$length(), idx))) {
        return nil
      };
      return string_bytes['$[]'](idx);
    }, 1);
    
    $def(self, '$initialize_copy', function $$initialize_copy(other) {
      
      return "\n" + "      self.encoding = other.encoding;\n" + "      self.internal_encoding = other.internal_encoding;\n" + "    "
    }, 1);
    
    $def(self, '$length', function $$length() {
      var self = this;

      return self.length;
    }, 0);
    $alias(self, "size", "length");
    return $def(self, '$valid_encoding?', $return_val(true), 0);
  })('::', null);
  return ($a = [$$$($$('Encoding'), 'UTF_8')], $send($$$('Encoding'), 'default_external=', $a), $a[$a.length - 1]);
};

Opal.modules["corelib/math"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $type_error = Opal.type_error, $module = Opal.module, $const_set = Opal.const_set, $Class = Opal.Class, $Kernel = Opal.Kernel, $defs = Opal.defs, $truthy = Opal.truthy, $send = Opal.send, $def = Opal.def, $rb_minus = Opal.rb_minus, $eqeqeq = Opal.eqeqeq, $rb_divide = Opal.rb_divide;

  Opal.add_stubs('new,raise,Float,Integer,module_function,each,define_method,checked,float!,===,gamma,-,integer!,/,infinite?');
  return (function($base, $parent_nesting) {
    var self = $module($base, 'Math');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    $const_set(self, 'E', Math.E);
    $const_set(self, 'PI', Math.PI);
    $const_set(self, 'DomainError', $Class.$new($$$('StandardError')));
    $defs(self, '$checked', function $$checked(method, $a) {
      var $post_args, args;

      
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      
      if (isNaN(args[0]) || (args.length == 2 && isNaN(args[1]))) {
        return NaN;
      }

      var result = Math[method].apply(null, args);

      if (isNaN(result)) {
        $Kernel.$raise($$('DomainError'), "Numerical argument is out of domain - \"" + (method) + "\"");
      }

      return result;
    ;
    }, -2);
    $defs(self, '$float!', function $Math_float$excl$1(value) {
      
      try {
        return $Kernel.$Float(value)
      } catch ($err) {
        if (Opal.rescue($err, [$$$('ArgumentError')])) {
          try {
            return $Kernel.$raise($type_error(value, $$$('Float')))
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      }
    }, 1);
    $defs(self, '$integer!', function $Math_integer$excl$2(value) {
      
      try {
        return $Kernel.$Integer(value)
      } catch ($err) {
        if (Opal.rescue($err, [$$$('ArgumentError')])) {
          try {
            return $Kernel.$raise($type_error(value, $$$('Integer')))
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      }
    }, 1);
    self.$module_function();
    if (!$truthy((typeof(Math.erf) !== "undefined"))) {
      
      Opal.prop(Math, 'erf', function(x) {
        var A1 =  0.254829592,
            A2 = -0.284496736,
            A3 =  1.421413741,
            A4 = -1.453152027,
            A5 =  1.061405429,
            P  =  0.3275911;

        var sign = 1;

        if (x < 0) {
            sign = -1;
        }

        x = Math.abs(x);

        var t = 1.0 / (1.0 + P * x);
        var y = 1.0 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * Math.exp(-x * x);

        return sign * y;
      });
    
    };
    if (!$truthy((typeof(Math.erfc) !== "undefined"))) {
      
      Opal.prop(Math, 'erfc', function(x) {
        var z = Math.abs(x),
            t = 1.0 / (0.5 * z + 1.0);

        var A1 = t * 0.17087277 + -0.82215223,
            A2 = t * A1 + 1.48851587,
            A3 = t * A2 + -1.13520398,
            A4 = t * A3 + 0.27886807,
            A5 = t * A4 + -0.18628806,
            A6 = t * A5 + 0.09678418,
            A7 = t * A6 + 0.37409196,
            A8 = t * A7 + 1.00002368,
            A9 = t * A8,
            A10 = -z * z - 1.26551223 + A9;

        var a = t * Math.exp(A10);

        if (x < 0.0) {
          return 2.0 - a;
        }
        else {
          return a;
        }
      });
    
    };
    $send(["acos", "acosh", "asin", "asinh", "atan", "atanh", "cbrt", "cos", "cosh", "erf", "erfc", "exp", "sin", "sinh", "sqrt", "tanh"], 'each', [], function $Math$3(method){var self = $Math$3.$$s == null ? this : $Math$3.$$s;

      
      
      if (method == null) method = nil;;
      return $send(self, 'define_method', [method], function $$4(x){
        
        
        if (x == null) x = nil;;
        return $$$('Math').$checked(method, $$$('Math')['$float!'](x));}, 1);}, {$$arity: 1, $$s: self});
    
    $def(self, '$atan2', function $$atan2(y, x) {
      
      return $$$('Math').$checked("atan2", $$$('Math')['$float!'](y), $$$('Math')['$float!'](x))
    }, 2);
    
    $def(self, '$hypot', function $$hypot(x, y) {
      
      return $$$('Math').$checked("hypot", $$$('Math')['$float!'](x), $$$('Math')['$float!'](y))
    }, 2);
    
    $def(self, '$frexp', function $$frexp(x) {
      
      
      x = $$('Math')['$float!'](x);
      
      if (isNaN(x)) {
        return [NaN, 0];
      }

      var ex   = Math.floor(Math.log(Math.abs(x)) / Math.log(2)) + 1,
          frac = x / Math.pow(2, ex);

      return [frac, ex];
    ;
    }, 1);
    
    $def(self, '$gamma', function $$gamma(n) {
      
      
      n = $$('Math')['$float!'](n);
      
      var i, t, x, value, result, twoN, threeN, fourN, fiveN;

      var G = 4.7421875;

      var P = [
         0.99999999999999709182,
         57.156235665862923517,
        -59.597960355475491248,
         14.136097974741747174,
        -0.49191381609762019978,
         0.33994649984811888699e-4,
         0.46523628927048575665e-4,
        -0.98374475304879564677e-4,
         0.15808870322491248884e-3,
        -0.21026444172410488319e-3,
         0.21743961811521264320e-3,
        -0.16431810653676389022e-3,
         0.84418223983852743293e-4,
        -0.26190838401581408670e-4,
         0.36899182659531622704e-5
      ];


      if (isNaN(n)) {
        return NaN;
      }

      if (n === 0 && 1 / n < 0) {
        return -Infinity;
      }

      if (n === -1 || n === -Infinity) {
        $Kernel.$raise($$('DomainError'), "Numerical argument is out of domain - \"gamma\"");
      }

      if ($$('Integer')['$==='](n)) {
        if (n <= 0) {
          return isFinite(n) ? Infinity : NaN;
        }

        if (n > 171) {
          return Infinity;
        }

        value  = n - 2;
        result = n - 1;

        while (value > 1) {
          result *= value;
          value--;
        }

        if (result == 0) {
          result = 1;
        }

        return result;
      }

      if (n < 0.5) {
        return Math.PI / (Math.sin(Math.PI * n) * $$$('Math').$gamma($rb_minus(1, n)));
      }

      if (n >= 171.35) {
        return Infinity;
      }

      if (n > 85.0) {
        twoN   = n * n;
        threeN = twoN * n;
        fourN  = threeN * n;
        fiveN  = fourN * n;

        return Math.sqrt(2 * Math.PI / n) * Math.pow((n / Math.E), n) *
          (1 + 1 / (12 * n) + 1 / (288 * twoN) - 139 / (51840 * threeN) -
          571 / (2488320 * fourN) + 163879 / (209018880 * fiveN) +
          5246819 / (75246796800 * fiveN * n));
      }

      n -= 1;
      x  = P[0];

      for (i = 1; i < P.length; ++i) {
        x += P[i] / (n + i);
      }

      t = n + G + 0.5;

      return Math.sqrt(2 * Math.PI) * Math.pow(t, n + 0.5) * Math.exp(-t) * x;
    ;
    }, 1);
    
    $def(self, '$ldexp', function $$ldexp(mantissa, exponent) {
      
      
      mantissa = $$('Math')['$float!'](mantissa);
      exponent = $$('Math')['$integer!'](exponent);
      
      if (isNaN(exponent)) {
        $Kernel.$raise($$$('RangeError'), "float NaN out of range of integer");
      }

      return mantissa * Math.pow(2, exponent);
    ;
    }, 2);
    
    $def(self, '$lgamma', function $$lgamma(n) {
      
      
      if (n == -1) {
        return [Infinity, 1];
      }
      else {
        return [Math.log(Math.abs($$$('Math').$gamma(n))), $$$('Math').$gamma(n) < 0 ? -1 : 1];
      }
    
    }, 1);
    
    $def(self, '$log', function $$log(x, base) {
      
      
      ;
      if ($eqeqeq($$$('String'), x)) {
        $Kernel.$raise($type_error(x, $$$('Float')))
      };
      if ($truthy(base == null)) {
        return $$$('Math').$checked("log", $$$('Math')['$float!'](x))
      } else {
        
        if ($eqeqeq($$$('String'), base)) {
          $Kernel.$raise($type_error(base, $$$('Float')))
        };
        return $rb_divide($$$('Math').$checked("log", $$$('Math')['$float!'](x)), $$$('Math').$checked("log", $$$('Math')['$float!'](base)));
      };
    }, -2);
    
    $def(self, '$log10', function $$log10(x) {
      
      
      if ($eqeqeq($$$('String'), x)) {
        $Kernel.$raise($type_error(x, $$$('Float')))
      };
      return $$$('Math').$checked("log10", $$$('Math')['$float!'](x));
    }, 1);
    
    $def(self, '$log2', function $$log2(x) {
      
      
      if ($eqeqeq($$$('String'), x)) {
        $Kernel.$raise($type_error(x, $$$('Float')))
      };
      return $$$('Math').$checked("log2", $$$('Math')['$float!'](x));
    }, 1);
    return $def(self, '$tan', function $$tan(x) {
      
      
      x = $$$('Math')['$float!'](x);
      if ($truthy(x['$infinite?']())) {
        return $$$($$$('Float'), 'NAN')
      };
      return $$$('Math').$checked("tan", $$$('Math')['$float!'](x));
    }, 1);
  })('::', $nesting)
};

Opal.modules["corelib/complex/base"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $module = Opal.module, $truthy = Opal.truthy, $def = Opal.def, $klass = Opal.klass;

  Opal.add_stubs('new,from_string');
  
  (function($base, $parent_nesting) {
    var self = $module($base, 'Kernel');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    return $def(self, '$Complex', function $$Complex(real, imag) {
      
      
      
      if (imag == null) imag = nil;;
      if ($truthy(imag)) {
        return $$('Complex').$new(real, imag)
      } else {
        return $$('Complex').$new(real, 0)
      };
    }, -2)
  })('::', $nesting);
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'String');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    return $def(self, '$to_c', function $$to_c() {
      var self = this;

      return $$('Complex').$from_string(self)
    }, 0)
  })('::', null, $nesting);
};

Opal.modules["corelib/complex"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $truthy = Opal.truthy, $eqeqeq = Opal.eqeqeq, $Kernel = Opal.Kernel, $defs = Opal.defs, $rb_times = Opal.rb_times, $def = Opal.def, $rb_plus = Opal.rb_plus, $rb_minus = Opal.rb_minus, $rb_divide = Opal.rb_divide, $eqeq = Opal.eqeq, $to_ary = Opal.to_ary, $rb_gt = Opal.rb_gt, $neqeq = Opal.neqeq, $return_val = Opal.return_val, $const_set = Opal.const_set, $alias = Opal.alias;

  Opal.add_stubs('require,real?,===,raise,new,*,cos,sin,attr_reader,class,==,real,imag,Complex,-@,+,__coerced__,-,nan?,/,conj,abs2,quo,polar,exp,log,>,!=,divmod,**,hypot,atan2,lcm,denominator,finite?,infinite?,numerator,abs,arg,rationalize,to_f,to_i,to_r,inspect,zero?,positive?,Rational,rect,angle');
  
  self.$require("corelib/numeric");
  self.$require("corelib/complex/base");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Complex');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.real = $proto.imag = nil;
    
    $defs(self, '$rect', function $$rect(real, imag) {
      var self = this;

      
      
      if (imag == null) imag = 0;;
      if (!((($eqeqeq($$$('Numeric'), real) && ($truthy(real['$real?']()))) && ($eqeqeq($$$('Numeric'), imag))) && ($truthy(imag['$real?']())))) {
        $Kernel.$raise($$$('TypeError'), "not a real")
      };
      return self.$new(real, imag);
    }, -2);
    $defs(self, '$polar', function $$polar(r, theta) {
      var self = this;

      
      
      if (theta == null) theta = 0;;
      if (!((($eqeqeq($$$('Numeric'), r) && ($truthy(r['$real?']()))) && ($eqeqeq($$$('Numeric'), theta))) && ($truthy(theta['$real?']())))) {
        $Kernel.$raise($$$('TypeError'), "not a real")
      };
      return self.$new($rb_times(r, $$$('Math').$cos(theta)), $rb_times(r, $$$('Math').$sin(theta)));
    }, -2);
    self.$attr_reader("real", "imag");
    
    $def(self, '$initialize', function $$initialize(real, imag) {
      var self = this;

      
      
      if (imag == null) imag = 0;;
      self.real = real;
      return (self.imag = imag);
    }, -2);
    
    $def(self, '$coerce', function $$coerce(other) {
      var self = this;

      if ($eqeqeq($$$('Complex'), other)) {
        return [other, self]
      } else if (($eqeqeq($$$('Numeric'), other) && ($truthy(other['$real?']())))) {
        return [$$$('Complex').$new(other, 0), self]
      } else {
        return $Kernel.$raise($$$('TypeError'), "" + (other.$class()) + " can't be coerced into Complex")
      }
    }, 1);
    
    $def(self, '$==', function $Complex_$eq_eq$1(other) {
      var self = this, $ret_or_1 = nil;

      if ($eqeqeq($$$('Complex'), other)) {
        if ($truthy(($ret_or_1 = self.real['$=='](other.$real())))) {
          return self.imag['$=='](other.$imag())
        } else {
          return $ret_or_1
        }
      } else if (($eqeqeq($$$('Numeric'), other) && ($truthy(other['$real?']())))) {
        if ($truthy(($ret_or_1 = self.real['$=='](other)))) {
          return self.imag['$=='](0)
        } else {
          return $ret_or_1
        }
      } else {
        return other['$=='](self)
      }
    }, 1);
    
    $def(self, '$-@', function $Complex_$minus$$2() {
      var self = this;

      return $Kernel.$Complex(self.real['$-@'](), self.imag['$-@']())
    }, 0);
    
    $def(self, '$+', function $Complex_$plus$3(other) {
      var self = this;

      if ($eqeqeq($$$('Complex'), other)) {
        return $Kernel.$Complex($rb_plus(self.real, other.$real()), $rb_plus(self.imag, other.$imag()))
      } else if (($eqeqeq($$$('Numeric'), other) && ($truthy(other['$real?']())))) {
        return $Kernel.$Complex($rb_plus(self.real, other), self.imag)
      } else {
        return self.$__coerced__("+", other)
      }
    }, 1);
    
    $def(self, '$-', function $Complex_$minus$4(other) {
      var self = this;

      if ($eqeqeq($$$('Complex'), other)) {
        return $Kernel.$Complex($rb_minus(self.real, other.$real()), $rb_minus(self.imag, other.$imag()))
      } else if (($eqeqeq($$$('Numeric'), other) && ($truthy(other['$real?']())))) {
        return $Kernel.$Complex($rb_minus(self.real, other), self.imag)
      } else {
        return self.$__coerced__("-", other)
      }
    }, 1);
    
    $def(self, '$*', function $Complex_$$5(other) {
      var self = this;

      if ($eqeqeq($$$('Complex'), other)) {
        return $Kernel.$Complex($rb_minus($rb_times(self.real, other.$real()), $rb_times(self.imag, other.$imag())), $rb_plus($rb_times(self.real, other.$imag()), $rb_times(self.imag, other.$real())))
      } else if (($eqeqeq($$$('Numeric'), other) && ($truthy(other['$real?']())))) {
        return $Kernel.$Complex($rb_times(self.real, other), $rb_times(self.imag, other))
      } else {
        return self.$__coerced__("*", other)
      }
    }, 1);
    
    $def(self, '$/', function $Complex_$slash$6(other) {
      var self = this;

      if ($eqeqeq($$$('Complex'), other)) {
        if ((((($eqeqeq($$$('Number'), self.real) && ($truthy(self.real['$nan?']()))) || (($eqeqeq($$$('Number'), self.imag) && ($truthy(self.imag['$nan?']()))))) || (($eqeqeq($$$('Number'), other.$real()) && ($truthy(other.$real()['$nan?']()))))) || (($eqeqeq($$$('Number'), other.$imag()) && ($truthy(other.$imag()['$nan?']())))))) {
          return $$$('Complex').$new($$$($$$('Float'), 'NAN'), $$$($$$('Float'), 'NAN'))
        } else {
          return $rb_divide($rb_times(self, other.$conj()), other.$abs2())
        }
      } else if (($eqeqeq($$$('Numeric'), other) && ($truthy(other['$real?']())))) {
        return $Kernel.$Complex(self.real.$quo(other), self.imag.$quo(other))
      } else {
        return self.$__coerced__("/", other)
      }
    }, 1);
    
    $def(self, '$**', function $Complex_$$$7(other) {
      var $a, $b, $c, $d, self = this, r = nil, theta = nil, ore = nil, oim = nil, nr = nil, ntheta = nil, x = nil, z = nil, n = nil, div = nil, mod = nil;

      
      if ($eqeq(other, 0)) {
        return $$$('Complex').$new(1, 0)
      };
      if ($eqeqeq($$$('Complex'), other)) {
        
        $b = self.$polar(), $a = $to_ary($b), (r = ($a[0] == null ? nil : $a[0])), (theta = ($a[1] == null ? nil : $a[1])), $b;
        ore = other.$real();
        oim = other.$imag();
        nr = $$$('Math').$exp($rb_minus($rb_times(ore, $$$('Math').$log(r)), $rb_times(oim, theta)));
        ntheta = $rb_plus($rb_times(theta, ore), $rb_times(oim, $$$('Math').$log(r)));
        return $$$('Complex').$polar(nr, ntheta);
      } else if ($eqeqeq($$$('Integer'), other)) {
        if ($truthy($rb_gt(other, 0))) {
          
          x = self;
          z = x;
          n = $rb_minus(other, 1);
          while ($neqeq(n, 0)) {
            
            $c = n.$divmod(2), $b = $to_ary($c), (div = ($b[0] == null ? nil : $b[0])), (mod = ($b[1] == null ? nil : $b[1])), $c;
            while ($eqeq(mod, 0)) {
              
              x = $Kernel.$Complex($rb_minus($rb_times(x.$real(), x.$real()), $rb_times(x.$imag(), x.$imag())), $rb_times($rb_times(2, x.$real()), x.$imag()));
              n = div;
              $d = n.$divmod(2), $c = $to_ary($d), (div = ($c[0] == null ? nil : $c[0])), (mod = ($c[1] == null ? nil : $c[1])), $d;
            };
            z = $rb_times(z, x);
            n = $rb_minus(n, 1);
          };
          return z;
        } else {
          return $rb_divide($$$('Rational').$new(1, 1), self)['$**'](other['$-@']())
        }
      } else if (($eqeqeq($$$('Float'), other) || ($eqeqeq($$$('Rational'), other)))) {
        
        $b = self.$polar(), $a = $to_ary($b), (r = ($a[0] == null ? nil : $a[0])), (theta = ($a[1] == null ? nil : $a[1])), $b;
        return $$$('Complex').$polar(r['$**'](other), $rb_times(theta, other));
      } else {
        return self.$__coerced__("**", other)
      };
    }, 1);
    
    $def(self, '$abs', function $$abs() {
      var self = this;

      return $$$('Math').$hypot(self.real, self.imag)
    }, 0);
    
    $def(self, '$abs2', function $$abs2() {
      var self = this;

      return $rb_plus($rb_times(self.real, self.real), $rb_times(self.imag, self.imag))
    }, 0);
    
    $def(self, '$angle', function $$angle() {
      var self = this;

      return $$$('Math').$atan2(self.imag, self.real)
    }, 0);
    
    $def(self, '$conj', function $$conj() {
      var self = this;

      return $Kernel.$Complex(self.real, self.imag['$-@']())
    }, 0);
    
    $def(self, '$denominator', function $$denominator() {
      var self = this;

      return self.real.$denominator().$lcm(self.imag.$denominator())
    }, 0);
    
    $def(self, '$eql?', function $Complex_eql$ques$8(other) {
      var self = this, $ret_or_1 = nil, $ret_or_2 = nil;

      if ($truthy(($ret_or_1 = ($truthy(($ret_or_2 = $$('Complex')['$==='](other))) ? (self.real.$class()['$=='](self.imag.$class())) : ($ret_or_2))))) {
        return self['$=='](other)
      } else {
        return $ret_or_1
      }
    }, 1);
    
    $def(self, '$fdiv', function $$fdiv(other) {
      var self = this;

      
      if (!$eqeqeq($$$('Numeric'), other)) {
        $Kernel.$raise($$$('TypeError'), "" + (other.$class()) + " can't be coerced into Complex")
      };
      return $rb_divide(self, other);
    }, 1);
    
    $def(self, '$finite?', function $Complex_finite$ques$9() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.real['$finite?']()))) {
        return self.imag['$finite?']()
      } else {
        return $ret_or_1
      }
    }, 0);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      return "Complex:" + (self.real) + ":" + (self.imag)
    }, 0);
    
    $def(self, '$infinite?', function $Complex_infinite$ques$10() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.real['$infinite?']()))) {
        return $ret_or_1
      } else {
        return self.imag['$infinite?']()
      }
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      return "(" + (self) + ")"
    }, 0);
    
    $def(self, '$numerator', function $$numerator() {
      var self = this, d = nil;

      
      d = self.$denominator();
      return $Kernel.$Complex($rb_times(self.real.$numerator(), $rb_divide(d, self.real.$denominator())), $rb_times(self.imag.$numerator(), $rb_divide(d, self.imag.$denominator())));
    }, 0);
    
    $def(self, '$polar', function $$polar() {
      var self = this;

      return [self.$abs(), self.$arg()]
    }, 0);
    
    $def(self, '$rationalize', function $$rationalize(eps) {
      var self = this;

      
      ;
      
      if (arguments.length > 1) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..1)");
      }
    ;
      if ($neqeq(self.imag, 0)) {
        $Kernel.$raise($$$('RangeError'), "can't convert " + (self) + " into Rational")
      };
      return self.$real().$rationalize(eps);
    }, -1);
    
    $def(self, '$real?', $return_val(false), 0);
    
    $def(self, '$rect', function $$rect() {
      var self = this;

      return [self.real, self.imag]
    }, 0);
    
    $def(self, '$to_f', function $$to_f() {
      var self = this;

      
      if (!$eqeq(self.imag, 0)) {
        $Kernel.$raise($$$('RangeError'), "can't convert " + (self) + " into Float")
      };
      return self.real.$to_f();
    }, 0);
    
    $def(self, '$to_i', function $$to_i() {
      var self = this;

      
      if (!$eqeq(self.imag, 0)) {
        $Kernel.$raise($$$('RangeError'), "can't convert " + (self) + " into Integer")
      };
      return self.real.$to_i();
    }, 0);
    
    $def(self, '$to_r', function $$to_r() {
      var self = this;

      
      if (!$eqeq(self.imag, 0)) {
        $Kernel.$raise($$$('RangeError'), "can't convert " + (self) + " into Rational")
      };
      return self.real.$to_r();
    }, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this, result = nil;

      
      result = self.real.$inspect();
      result = $rb_plus(result, (((($eqeqeq($$$('Number'), self.imag) && ($truthy(self.imag['$nan?']()))) || ($truthy(self.imag['$positive?']()))) || ($truthy(self.imag['$zero?']()))) ? ("+") : ("-")));
      result = $rb_plus(result, self.imag.$abs().$inspect());
      if (($eqeqeq($$$('Number'), self.imag) && (($truthy(self.imag['$nan?']()) || ($truthy(self.imag['$infinite?']())))))) {
        result = $rb_plus(result, "*")
      };
      return $rb_plus(result, "i");
    }, 0);
    $const_set($nesting[0], 'I', self.$new(0, 1));
    $defs(self, '$from_string', function $$from_string(str) {
      
      
      var re = /[+-]?[\d_]+(\.[\d_]+)?(e\d+)?/,
          match = str.match(re),
          real, imag, denominator;

      function isFloat() {
        return re.test(str);
      }

      function cutFloat() {
        var match = str.match(re);
        var number = match[0];
        str = str.slice(number.length);
        return number.replace(/_/g, '');
      }

      // handles both floats and rationals
      function cutNumber() {
        if (isFloat()) {
          var numerator = parseFloat(cutFloat());

          if (str[0] === '/') {
            // rational real part
            str = str.slice(1);

            if (isFloat()) {
              var denominator = parseFloat(cutFloat());
              return $Kernel.$Rational(numerator, denominator);
            } else {
              // reverting '/'
              str = '/' + str;
              return numerator;
            }
          } else {
            // float real part, no denominator
            return numerator;
          }
        } else {
          return null;
        }
      }

      real = cutNumber();

      if (!real) {
        if (str[0] === 'i') {
          // i => Complex(0, 1)
          return $Kernel.$Complex(0, 1);
        }
        if (str[0] === '-' && str[1] === 'i') {
          // -i => Complex(0, -1)
          return $Kernel.$Complex(0, -1);
        }
        if (str[0] === '+' && str[1] === 'i') {
          // +i => Complex(0, 1)
          return $Kernel.$Complex(0, 1);
        }
        // anything => Complex(0, 0)
        return $Kernel.$Complex(0, 0);
      }

      imag = cutNumber();
      if (!imag) {
        if (str[0] === 'i') {
          // 3i => Complex(0, 3)
          return $Kernel.$Complex(0, real);
        } else {
          // 3 => Complex(3, 0)
          return $Kernel.$Complex(real, 0);
        }
      } else {
        // 3+2i => Complex(3, 2)
        return $Kernel.$Complex(real, imag);
      }
    
    }, 1);
    (function(self, $parent_nesting) {
      
      return $alias(self, "rectangular", "rect")
    })(Opal.get_singleton_class(self), $nesting);
    $alias(self, "arg", "angle");
    $alias(self, "conjugate", "conj");
    $alias(self, "divide", "/");
    $alias(self, "imaginary", "imag");
    $alias(self, "magnitude", "abs");
    $alias(self, "phase", "arg");
    $alias(self, "quo", "/");
    $alias(self, "rectangular", "rect");
    
    Opal.udef(self, '$' + "negative?");;
    
    Opal.udef(self, '$' + "positive?");;
    
    
    Opal.udef(self, '$' + "step");;
    return nil;;
  })('::', $$$('Numeric'), $nesting);
};

Opal.modules["corelib/rational/base"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $def = Opal.def, $klass = Opal.klass;

  Opal.add_stubs('convert,from_string');
  
  (function($base) {
    var self = $module($base, 'Kernel');

    
    return $def(self, '$Rational', function $$Rational(numerator, denominator) {
      
      
      
      if (denominator == null) denominator = 1;;
      return $$$('Rational').$convert(numerator, denominator);
    }, -2)
  })('::');
  return (function($base, $super) {
    var self = $klass($base, $super, 'String');

    
    return $def(self, '$to_r', function $$to_r() {
      var self = this;

      return $$$('Rational').$from_string(self)
    }, 0)
  })('::', null);
};

Opal.modules["corelib/rational"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $eqeq = Opal.eqeq, $Kernel = Opal.Kernel, $truthy = Opal.truthy, $rb_lt = Opal.rb_lt, $rb_divide = Opal.rb_divide, $defs = Opal.defs, $eqeqeq = Opal.eqeqeq, $not = Opal.not, $Opal = Opal.Opal, $def = Opal.def, $return_ivar = Opal.return_ivar, $rb_minus = Opal.rb_minus, $rb_times = Opal.rb_times, $rb_plus = Opal.rb_plus, $rb_gt = Opal.rb_gt, $rb_le = Opal.rb_le, $return_self = Opal.return_self, $alias = Opal.alias;

  Opal.add_stubs('require,to_i,==,raise,<,-@,new,gcd,/,nil?,===,reduce,to_r,!,equal?,coerce_to!,to_f,numerator,denominator,<=>,-,*,__coerced__,+,Rational,>,**,abs,ceil,with_precision,floor,<=,truncate,send');
  
  self.$require("corelib/numeric");
  self.$require("corelib/rational/base");
  return (function($base, $super) {
    var self = $klass($base, $super, 'Rational');

    var $proto = self.$$prototype;

    $proto.num = $proto.den = nil;
    
    $defs(self, '$reduce', function $$reduce(num, den) {
      var self = this, gcd = nil;

      
      num = num.$to_i();
      den = den.$to_i();
      if ($eqeq(den, 0)) {
        $Kernel.$raise($$$('ZeroDivisionError'), "divided by 0")
      } else if ($truthy($rb_lt(den, 0))) {
        
        num = num['$-@']();
        den = den['$-@']();
      } else if ($eqeq(den, 1)) {
        return self.$new(num, den)
      };
      gcd = num.$gcd(den);
      return self.$new($rb_divide(num, gcd), $rb_divide(den, gcd));
    }, 2);
    $defs(self, '$convert', function $$convert(num, den) {
      var self = this;

      
      if (($truthy(num['$nil?']()) || ($truthy(den['$nil?']())))) {
        $Kernel.$raise($$$('TypeError'), "cannot convert nil into Rational")
      };
      if (($eqeqeq($$$('Integer'), num) && ($eqeqeq($$$('Integer'), den)))) {
        return self.$reduce(num, den)
      };
      if ((($eqeqeq($$$('Float'), num) || ($eqeqeq($$$('String'), num))) || ($eqeqeq($$$('Complex'), num)))) {
        num = num.$to_r()
      };
      if ((($eqeqeq($$$('Float'), den) || ($eqeqeq($$$('String'), den))) || ($eqeqeq($$$('Complex'), den)))) {
        den = den.$to_r()
      };
      if (($truthy(den['$equal?'](1)) && ($not($$$('Integer')['$==='](num))))) {
        return $Opal['$coerce_to!'](num, $$$('Rational'), "to_r")
      } else if (($eqeqeq($$$('Numeric'), num) && ($eqeqeq($$$('Numeric'), den)))) {
        return $rb_divide(num, den)
      } else {
        return self.$reduce(num, den)
      };
    }, 2);
    
    $def(self, '$initialize', function $$initialize(num, den) {
      var self = this;

      
      self.num = num;
      return (self.den = den);
    }, 2);
    
    $def(self, '$numerator', $return_ivar("num"), 0);
    
    $def(self, '$denominator', $return_ivar("den"), 0);
    
    $def(self, '$coerce', function $$coerce(other) {
      var self = this, $ret_or_1 = nil;

      if ($eqeqeq($$$('Rational'), ($ret_or_1 = other))) {
        return [other, self]
      } else if ($eqeqeq($$$('Integer'), $ret_or_1)) {
        return [other.$to_r(), self]
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return [other, self.$to_f()]
      } else {
        return nil
      }
    }, 1);
    
    $def(self, '$==', function $Rational_$eq_eq$1(other) {
      var self = this, $ret_or_1 = nil, $ret_or_2 = nil;

      if ($eqeqeq($$$('Rational'), ($ret_or_1 = other))) {
        if ($truthy(($ret_or_2 = self.num['$=='](other.$numerator())))) {
          return self.den['$=='](other.$denominator())
        } else {
          return $ret_or_2
        }
      } else if ($eqeqeq($$$('Integer'), $ret_or_1)) {
        if ($truthy(($ret_or_2 = self.num['$=='](other)))) {
          return self.den['$=='](1)
        } else {
          return $ret_or_2
        }
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return self.$to_f()['$=='](other)
      } else {
        return other['$=='](self)
      }
    }, 1);
    
    $def(self, '$<=>', function $Rational_$lt_eq_gt$2(other) {
      var self = this, $ret_or_1 = nil;

      if ($eqeqeq($$$('Rational'), ($ret_or_1 = other))) {
        return $rb_minus($rb_times(self.num, other.$denominator()), $rb_times(self.den, other.$numerator()))['$<=>'](0)
      } else if ($eqeqeq($$$('Integer'), $ret_or_1)) {
        return $rb_minus(self.num, $rb_times(self.den, other))['$<=>'](0)
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return self.$to_f()['$<=>'](other)
      } else {
        return self.$__coerced__("<=>", other)
      }
    }, 1);
    
    $def(self, '$+', function $Rational_$plus$3(other) {
      var self = this, $ret_or_1 = nil, num = nil, den = nil;

      if ($eqeqeq($$$('Rational'), ($ret_or_1 = other))) {
        
        num = $rb_plus($rb_times(self.num, other.$denominator()), $rb_times(self.den, other.$numerator()));
        den = $rb_times(self.den, other.$denominator());
        return $Kernel.$Rational(num, den);
      } else if ($eqeqeq($$$('Integer'), $ret_or_1)) {
        return $Kernel.$Rational($rb_plus(self.num, $rb_times(other, self.den)), self.den)
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return $rb_plus(self.$to_f(), other)
      } else {
        return self.$__coerced__("+", other)
      }
    }, 1);
    
    $def(self, '$-', function $Rational_$minus$4(other) {
      var self = this, $ret_or_1 = nil, num = nil, den = nil;

      if ($eqeqeq($$$('Rational'), ($ret_or_1 = other))) {
        
        num = $rb_minus($rb_times(self.num, other.$denominator()), $rb_times(self.den, other.$numerator()));
        den = $rb_times(self.den, other.$denominator());
        return $Kernel.$Rational(num, den);
      } else if ($eqeqeq($$$('Integer'), $ret_or_1)) {
        return $Kernel.$Rational($rb_minus(self.num, $rb_times(other, self.den)), self.den)
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return $rb_minus(self.$to_f(), other)
      } else {
        return self.$__coerced__("-", other)
      }
    }, 1);
    
    $def(self, '$*', function $Rational_$$5(other) {
      var self = this, $ret_or_1 = nil, num = nil, den = nil;

      if ($eqeqeq($$$('Rational'), ($ret_or_1 = other))) {
        
        num = $rb_times(self.num, other.$numerator());
        den = $rb_times(self.den, other.$denominator());
        return $Kernel.$Rational(num, den);
      } else if ($eqeqeq($$$('Integer'), $ret_or_1)) {
        return $Kernel.$Rational($rb_times(self.num, other), self.den)
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return $rb_times(self.$to_f(), other)
      } else {
        return self.$__coerced__("*", other)
      }
    }, 1);
    
    $def(self, '$/', function $Rational_$slash$6(other) {
      var self = this, $ret_or_1 = nil, num = nil, den = nil;

      if ($eqeqeq($$$('Rational'), ($ret_or_1 = other))) {
        
        num = $rb_times(self.num, other.$denominator());
        den = $rb_times(self.den, other.$numerator());
        return $Kernel.$Rational(num, den);
      } else if ($eqeqeq($$$('Integer'), $ret_or_1)) {
        if ($eqeq(other, 0)) {
          return $rb_divide(self.$to_f(), 0.0)
        } else {
          return $Kernel.$Rational(self.num, $rb_times(self.den, other))
        }
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return $rb_divide(self.$to_f(), other)
      } else {
        return self.$__coerced__("/", other)
      }
    }, 1);
    
    $def(self, '$**', function $Rational_$$$7(other) {
      var self = this, $ret_or_1 = nil;

      if ($eqeqeq($$$('Integer'), ($ret_or_1 = other))) {
        if (($eqeq(self, 0) && ($truthy($rb_lt(other, 0))))) {
          return $$$($$$('Float'), 'INFINITY')
        } else if ($truthy($rb_gt(other, 0))) {
          return $Kernel.$Rational(self.num['$**'](other), self.den['$**'](other))
        } else if ($truthy($rb_lt(other, 0))) {
          return $Kernel.$Rational(self.den['$**'](other['$-@']()), self.num['$**'](other['$-@']()))
        } else {
          return $Kernel.$Rational(1, 1)
        }
      } else if ($eqeqeq($$$('Float'), $ret_or_1)) {
        return self.$to_f()['$**'](other)
      } else if ($eqeqeq($$$('Rational'), $ret_or_1)) {
        if ($eqeq(other, 0)) {
          return $Kernel.$Rational(1, 1)
        } else if ($eqeq(other.$denominator(), 1)) {
          if ($truthy($rb_lt(other, 0))) {
            return $Kernel.$Rational(self.den['$**'](other.$numerator().$abs()), self.num['$**'](other.$numerator().$abs()))
          } else {
            return $Kernel.$Rational(self.num['$**'](other.$numerator()), self.den['$**'](other.$numerator()))
          }
        } else if (($eqeq(self, 0) && ($truthy($rb_lt(other, 0))))) {
          return $Kernel.$raise($$$('ZeroDivisionError'), "divided by 0")
        } else {
          return self.$to_f()['$**'](other)
        }
      } else {
        return self.$__coerced__("**", other)
      }
    }, 1);
    
    $def(self, '$abs', function $$abs() {
      var self = this;

      return $Kernel.$Rational(self.num.$abs(), self.den.$abs())
    }, 0);
    
    $def(self, '$ceil', function $$ceil(precision) {
      var self = this;

      
      
      if (precision == null) precision = 0;;
      if ($eqeq(precision, 0)) {
        return $rb_divide(self.num['$-@'](), self.den)['$-@']().$ceil()
      } else {
        return self.$with_precision("ceil", precision)
      };
    }, -1);
    
    $def(self, '$floor', function $$floor(precision) {
      var self = this;

      
      
      if (precision == null) precision = 0;;
      if ($eqeq(precision, 0)) {
        return $rb_divide(self.num['$-@'](), self.den)['$-@']().$floor()
      } else {
        return self.$with_precision("floor", precision)
      };
    }, -1);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      return "Rational:" + (self.num) + ":" + (self.den)
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      return "(" + (self) + ")"
    }, 0);
    
    $def(self, '$rationalize', function $$rationalize(eps) {
      var self = this;

      
      ;
      
      if (arguments.length > 1) {
        $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..1)");
      }

      if (eps == null) {
        return self;
      }

      var e = eps.$abs(),
          a = $rb_minus(self, e),
          b = $rb_plus(self, e);

      var p0 = 0,
          p1 = 1,
          q0 = 1,
          q1 = 0,
          p2, q2;

      var c, k, t;

      while (true) {
        c = (a).$ceil();

        if ($rb_le(c, b)) {
          break;
        }

        k  = c - 1;
        p2 = k * p1 + p0;
        q2 = k * q1 + q0;
        t  = $rb_divide(1, $rb_minus(b, k));
        b  = $rb_divide(1, $rb_minus(a, k));
        a  = t;

        p0 = p1;
        q0 = q1;
        p1 = p2;
        q1 = q2;
      }

      return $Kernel.$Rational(c * p1 + p0, c * q1 + q0);
    ;
    }, -1);
    
    $def(self, '$round', function $$round(precision) {
      var self = this, num = nil, den = nil, approx = nil;

      
      
      if (precision == null) precision = 0;;
      if (!$eqeq(precision, 0)) {
        return self.$with_precision("round", precision)
      };
      if ($eqeq(self.num, 0)) {
        return 0
      };
      if ($eqeq(self.den, 1)) {
        return self.num
      };
      num = $rb_plus($rb_times(self.num.$abs(), 2), self.den);
      den = $rb_times(self.den, 2);
      approx = $rb_divide(num, den).$truncate();
      if ($truthy($rb_lt(self.num, 0))) {
        return approx['$-@']()
      } else {
        return approx
      };
    }, -1);
    
    $def(self, '$to_f', function $$to_f() {
      var self = this;

      return $rb_divide(self.num, self.den)
    }, 0);
    
    $def(self, '$to_i', function $$to_i() {
      var self = this;

      return self.$truncate()
    }, 0);
    
    $def(self, '$to_r', $return_self, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this;

      return "" + (self.num) + "/" + (self.den)
    }, 0);
    
    $def(self, '$truncate', function $$truncate(precision) {
      var self = this;

      
      
      if (precision == null) precision = 0;;
      if ($eqeq(precision, 0)) {
        if ($truthy($rb_lt(self.num, 0))) {
          return self.$ceil()
        } else {
          return self.$floor()
        }
      } else {
        return self.$with_precision("truncate", precision)
      };
    }, -1);
    
    $def(self, '$with_precision', function $$with_precision(method, precision) {
      var self = this, p = nil, s = nil;

      
      if (!$eqeqeq($$$('Integer'), precision)) {
        $Kernel.$raise($$$('TypeError'), "not an Integer")
      };
      p = (10)['$**'](precision);
      s = $rb_times(self, p);
      if ($truthy($rb_lt(precision, 1))) {
        return $rb_divide(s.$send(method), p).$to_i()
      } else {
        return $Kernel.$Rational(s.$send(method), p)
      };
    }, 2);
    $defs(self, '$from_string', function $$from_string(string) {
      
      
      var str = string.trimLeft(),
          re = /^[+-]?[\d_]+(\.[\d_]+)?/,
          match = str.match(re),
          numerator, denominator;

      function isFloat() {
        return re.test(str);
      }

      function cutFloat() {
        var match = str.match(re);
        var number = match[0];
        str = str.slice(number.length);
        return number.replace(/_/g, '');
      }

      if (isFloat()) {
        numerator = parseFloat(cutFloat());

        if (str[0] === '/') {
          // rational real part
          str = str.slice(1);

          if (isFloat()) {
            denominator = parseFloat(cutFloat());
            return $Kernel.$Rational(numerator, denominator);
          } else {
            return $Kernel.$Rational(numerator, 1);
          }
        } else {
          return $Kernel.$Rational(numerator, 1);
        }
      } else {
        return $Kernel.$Rational(0, 1);
      }
    
    }, 1);
    $alias(self, "divide", "/");
    return $alias(self, "quo", "/");
  })('::', $$$('Numeric'));
};

Opal.modules["corelib/time"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $slice = Opal.slice, $klass = Opal.klass, $Kernel = Opal.Kernel, $Opal = Opal.Opal, $defs = Opal.defs, $eqeqeq = Opal.eqeqeq, $def = Opal.def, $truthy = Opal.truthy, $rb_gt = Opal.rb_gt, $rb_lt = Opal.rb_lt, $send = Opal.send, $rb_plus = Opal.rb_plus, $rb_divide = Opal.rb_divide, $rb_minus = Opal.rb_minus, $range = Opal.range, $neqeq = Opal.neqeq, $rb_le = Opal.rb_le, $eqeq = Opal.eqeq, $alias = Opal.alias;

  Opal.add_stubs('require,include,===,raise,coerce_to!,respond_to?,to_str,to_i,_parse_offset,new,<=>,to_f,nil?,>,<,strftime,each,define_method,year,month,day,+,round,/,-,copy_instance_variables,initialize_dup,is_a?,zero?,wday,utc?,mon,yday,hour,min,sec,rjust,ljust,zone,to_s,[],cweek_cyear,jd,to_date,format,isdst,!=,<=,==,ceil,local,gm,asctime,getgm,gmt_offset,inspect,usec,gmtime,gmt?');
  
  self.$require("corelib/comparable");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Time');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    self.$include($$$('Comparable'));
    
    var days_of_week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        short_days   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        short_months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        long_months  = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  ;
    $defs(self, '$at', function $$at(seconds, frac) {
      
      
      ;
      
      var result;

      if ($$$('Time')['$==='](seconds)) {
        if (frac !== undefined) {
          $Kernel.$raise($$$('TypeError'), "can't convert Time into an exact number")
        }
        result = new Date(seconds.getTime());
        result.timezone = seconds.timezone;
        return result;
      }

      if (!seconds.$$is_number) {
        seconds = $Opal['$coerce_to!'](seconds, $$$('Integer'), "to_int");
      }

      if (frac === undefined) {
        return new Date(seconds * 1000);
      }

      if (!frac.$$is_number) {
        frac = $Opal['$coerce_to!'](frac, $$$('Integer'), "to_int");
      }

      return new Date(seconds * 1000 + (frac / 1000));
    ;
    }, -2);
    
    function time_params(year, month, day, hour, min, sec) {
      if (year.$$is_string) {
        year = parseInt(year, 10);
      } else {
        year = $Opal['$coerce_to!'](year, $$$('Integer'), "to_int");
      }

      if (month === nil) {
        month = 1;
      } else if (!month.$$is_number) {
        if ((month)['$respond_to?']("to_str")) {
          month = (month).$to_str();
          switch (month.toLowerCase()) {
          case 'jan': month =  1; break;
          case 'feb': month =  2; break;
          case 'mar': month =  3; break;
          case 'apr': month =  4; break;
          case 'may': month =  5; break;
          case 'jun': month =  6; break;
          case 'jul': month =  7; break;
          case 'aug': month =  8; break;
          case 'sep': month =  9; break;
          case 'oct': month = 10; break;
          case 'nov': month = 11; break;
          case 'dec': month = 12; break;
          default: month = (month).$to_i();
          }
        } else {
          month = $Opal['$coerce_to!'](month, $$$('Integer'), "to_int");
        }
      }

      if (month < 1 || month > 12) {
        $Kernel.$raise($$$('ArgumentError'), "month out of range: " + (month))
      }
      month = month - 1;

      if (day === nil) {
        day = 1;
      } else if (day.$$is_string) {
        day = parseInt(day, 10);
      } else {
        day = $Opal['$coerce_to!'](day, $$$('Integer'), "to_int");
      }

      if (day < 1 || day > 31) {
        $Kernel.$raise($$$('ArgumentError'), "day out of range: " + (day))
      }

      if (hour === nil) {
        hour = 0;
      } else if (hour.$$is_string) {
        hour = parseInt(hour, 10);
      } else {
        hour = $Opal['$coerce_to!'](hour, $$$('Integer'), "to_int");
      }

      if (hour < 0 || hour > 24) {
        $Kernel.$raise($$$('ArgumentError'), "hour out of range: " + (hour))
      }

      if (min === nil) {
        min = 0;
      } else if (min.$$is_string) {
        min = parseInt(min, 10);
      } else {
        min = $Opal['$coerce_to!'](min, $$$('Integer'), "to_int");
      }

      if (min < 0 || min > 59) {
        $Kernel.$raise($$$('ArgumentError'), "min out of range: " + (min))
      }

      if (sec === nil) {
        sec = 0;
      } else if (!sec.$$is_number) {
        if (sec.$$is_string) {
          sec = parseInt(sec, 10);
        } else {
          sec = $Opal['$coerce_to!'](sec, $$$('Integer'), "to_int");
        }
      }

      if (sec < 0 || sec > 60) {
        $Kernel.$raise($$$('ArgumentError'), "sec out of range: " + (sec))
      }

      return [year, month, day, hour, min, sec];
    }
  ;
    $defs(self, '$new', function $Time_new$1(year, month, day, hour, min, sec, utc_offset) {
      var self = this;

      
      ;
      
      if (month == null) month = nil;;
      
      if (day == null) day = nil;;
      
      if (hour == null) hour = nil;;
      
      if (min == null) min = nil;;
      
      if (sec == null) sec = nil;;
      
      if (utc_offset == null) utc_offset = nil;;
      
      var args, result, timezone, utc_date;

      if (year === undefined) {
        return new Date();
      }

      args  = time_params(year, month, day, hour, min, sec);
      year  = args[0];
      month = args[1];
      day   = args[2];
      hour  = args[3];
      min   = args[4];
      sec   = args[5];

      if (utc_offset === nil) {
        result = new Date(year, month, day, hour, min, 0, sec * 1000);
        if (year < 100) {
          result.setFullYear(year);
        }
        return result;
      }

      timezone = self.$_parse_offset(utc_offset);
      utc_date = new Date(Date.UTC(year, month, day, hour, min, 0, sec * 1000));
      if (year < 100) {
        utc_date.setUTCFullYear(year);
      }

      result = new Date(utc_date.getTime() - timezone * 3600000);
      result.timezone = timezone;

      return result;
    ;
    }, -1);
    $defs(self, '$_parse_offset', function $$_parse_offset(utc_offset) {
      
      
      var timezone;
      if (utc_offset.$$is_string) {
        if (utc_offset == 'UTC') {
          timezone = 0;
        }
        else if(/^[+-]\d\d:[0-5]\d$/.test(utc_offset)) {
          var sign, hours, minutes;
          sign = utc_offset[0];
          hours = +(utc_offset[1] + utc_offset[2]);
          minutes = +(utc_offset[4] + utc_offset[5]);

          timezone = (sign == '-' ? -1 : 1) * (hours + minutes / 60);
        }
        else {
          // Unsupported: "A".."I","K".."Z"
          $Kernel.$raise($$$('ArgumentError'), "\"+HH:MM\", \"-HH:MM\", \"UTC\" expected for utc_offset: " + (utc_offset))
        }
      }
      else if (utc_offset.$$is_number) {
        timezone = utc_offset / 3600;
      }
      else {
        $Kernel.$raise($$$('ArgumentError'), "Opal doesn't support other types for a timezone argument than Integer and String")
      }
      return timezone;
    
    }, 1);
    $defs(self, '$local', function $$local(year, month, day, hour, min, sec, millisecond, _dummy1, _dummy2, _dummy3) {
      
      
      
      if (month == null) month = nil;;
      
      if (day == null) day = nil;;
      
      if (hour == null) hour = nil;;
      
      if (min == null) min = nil;;
      
      if (sec == null) sec = nil;;
      
      if (millisecond == null) millisecond = nil;;
      
      if (_dummy1 == null) _dummy1 = nil;;
      
      if (_dummy2 == null) _dummy2 = nil;;
      
      if (_dummy3 == null) _dummy3 = nil;;
      
      var args, result;

      if (arguments.length === 10) {
        args  = $slice.call(arguments);
        year  = args[5];
        month = args[4];
        day   = args[3];
        hour  = args[2];
        min   = args[1];
        sec   = args[0];
      }

      args  = time_params(year, month, day, hour, min, sec);
      year  = args[0];
      month = args[1];
      day   = args[2];
      hour  = args[3];
      min   = args[4];
      sec   = args[5];

      result = new Date(year, month, day, hour, min, 0, sec * 1000);
      if (year < 100) {
        result.setFullYear(year);
      }
      return result;
    ;
    }, -2);
    $defs(self, '$gm', function $$gm(year, month, day, hour, min, sec, millisecond, _dummy1, _dummy2, _dummy3) {
      
      
      
      if (month == null) month = nil;;
      
      if (day == null) day = nil;;
      
      if (hour == null) hour = nil;;
      
      if (min == null) min = nil;;
      
      if (sec == null) sec = nil;;
      
      if (millisecond == null) millisecond = nil;;
      
      if (_dummy1 == null) _dummy1 = nil;;
      
      if (_dummy2 == null) _dummy2 = nil;;
      
      if (_dummy3 == null) _dummy3 = nil;;
      
      var args, result;

      if (arguments.length === 10) {
        args  = $slice.call(arguments);
        year  = args[5];
        month = args[4];
        day   = args[3];
        hour  = args[2];
        min   = args[1];
        sec   = args[0];
      }

      args  = time_params(year, month, day, hour, min, sec);
      year  = args[0];
      month = args[1];
      day   = args[2];
      hour  = args[3];
      min   = args[4];
      sec   = args[5];

      result = new Date(Date.UTC(year, month, day, hour, min, 0, sec * 1000));
      if (year < 100) {
        result.setUTCFullYear(year);
      }
      result.timezone = 0;
      return result;
    ;
    }, -2);
    $defs(self, '$now', function $$now() {
      var self = this;

      return self.$new()
    }, 0);
    
    $def(self, '$+', function $Time_$plus$2(other) {
      var self = this;

      
      if ($eqeqeq($$$('Time'), other)) {
        $Kernel.$raise($$$('TypeError'), "time + time?")
      };
      
      if (!other.$$is_number) {
        other = $Opal['$coerce_to!'](other, $$$('Integer'), "to_int");
      }
      var result = new Date(self.getTime() + (other * 1000));
      result.timezone = self.timezone;
      return result;
    ;
    }, 1);
    
    $def(self, '$-', function $Time_$minus$3(other) {
      var self = this;

      
      if ($eqeqeq($$$('Time'), other)) {
        return (self.getTime() - other.getTime()) / 1000
      };
      
      if (!other.$$is_number) {
        other = $Opal['$coerce_to!'](other, $$$('Integer'), "to_int");
      }
      var result = new Date(self.getTime() - (other * 1000));
      result.timezone = self.timezone;
      return result;
    ;
    }, 1);
    
    $def(self, '$<=>', function $Time_$lt_eq_gt$4(other) {
      var self = this, r = nil;

      if ($eqeqeq($$$('Time'), other)) {
        return self.$to_f()['$<=>'](other.$to_f())
      } else {
        
        r = other['$<=>'](self);
        if ($truthy(r['$nil?']())) {
          return nil
        } else if ($truthy($rb_gt(r, 0))) {
          return -1
        } else if ($truthy($rb_lt(r, 0))) {
          return 1
        } else {
          return 0
        };
      }
    }, 1);
    
    $def(self, '$==', function $Time_$eq_eq$5(other) {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = $$$('Time')['$==='](other)))) {
        return self.$to_f() === other.$to_f()
      } else {
        return $ret_or_1
      }
    }, 1);
    
    $def(self, '$asctime', function $$asctime() {
      var self = this;

      return self.$strftime("%a %b %e %H:%M:%S %Y")
    }, 0);
    $send([["year", "getFullYear", "getUTCFullYear"], ["mon", "getMonth", "getUTCMonth", 1], ["wday", "getDay", "getUTCDay"], ["day", "getDate", "getUTCDate"], ["hour", "getHours", "getUTCHours"], ["min", "getMinutes", "getUTCMinutes"], ["sec", "getSeconds", "getUTCSeconds"]], 'each', [], function $Time$6(method, getter, utcgetter, difference){var self = $Time$6.$$s == null ? this : $Time$6.$$s;

      
      
      if (method == null) method = nil;;
      
      if (getter == null) getter = nil;;
      
      if (utcgetter == null) utcgetter = nil;;
      
      if (difference == null) difference = 0;;
      return $send(self, 'define_method', [method], function $$7(){var self = $$7.$$s == null ? this : $$7.$$s;

        
        return difference + ((self.timezone != null) ?
          (new Date(self.getTime() + self.timezone * 3600000))[utcgetter]() :
          self[getter]())
      }, {$$arity: 0, $$s: self});}, {$$arity: -4, $$s: self});
    
    $def(self, '$yday', function $$yday() {
      var self = this, start_of_year = nil, start_of_day = nil, one_day = nil;

      
      start_of_year = $$('Time').$new(self.$year()).$to_i();
      start_of_day = $$('Time').$new(self.$year(), self.$month(), self.$day()).$to_i();
      one_day = 86400;
      return $rb_plus($rb_divide($rb_minus(start_of_day, start_of_year), one_day).$round(), 1);
    }, 0);
    
    $def(self, '$isdst', function $$isdst() {
      var self = this;

      
      var jan = new Date(self.getFullYear(), 0, 1),
          jul = new Date(self.getFullYear(), 6, 1);
      return self.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    
    }, 0);
    
    $def(self, '$dup', function $$dup() {
      var self = this, copy = nil;

      
      copy = new Date(self.getTime());
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    }, 0);
    
    $def(self, '$eql?', function $Time_eql$ques$8(other) {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = other['$is_a?']($$$('Time'))))) {
        return self['$<=>'](other)['$zero?']()
      } else {
        return $ret_or_1
      }
    }, 1);
    $send([["sunday?", 0], ["monday?", 1], ["tuesday?", 2], ["wednesday?", 3], ["thursday?", 4], ["friday?", 5], ["saturday?", 6]], 'each', [], function $Time$9(method, weekday){var self = $Time$9.$$s == null ? this : $Time$9.$$s;

      
      
      if (method == null) method = nil;;
      
      if (weekday == null) weekday = nil;;
      return $send(self, 'define_method', [method], function $$10(){var self = $$10.$$s == null ? this : $$10.$$s;

        return self.$wday() === weekday}, {$$arity: 0, $$s: self});}, {$$arity: 2, $$s: self});
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      return 'Time:' + self.getTime();
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      if ($truthy(self['$utc?']())) {
        return self.$strftime("%Y-%m-%d %H:%M:%S UTC")
      } else {
        return self.$strftime("%Y-%m-%d %H:%M:%S %z")
      }
    }, 0);
    
    $def(self, '$succ', function $$succ() {
      var self = this;

      
      var result = new Date(self.getTime() + 1000);
      result.timezone = self.timezone;
      return result;
    
    }, 0);
    
    $def(self, '$usec', function $$usec() {
      var self = this;

      return self.getMilliseconds() * 1000;
    }, 0);
    
    $def(self, '$zone', function $$zone() {
      var self = this;

      
      if (self.timezone === 0) return "UTC";
      else if (self.timezone != null) return nil;

      var string = self.toString(),
          result;

      if (string.indexOf('(') == -1) {
        result = string.match(/[A-Z]{3,4}/)[0];
      }
      else {
        result = string.match(/\((.+)\)(?:\s|$)/)[1]
      }

      if (result == "GMT" && /(GMT\W*\d{4})/.test(string)) {
        return RegExp.$1;
      }
      else {
        return result;
      }
    
    }, 0);
    
    $def(self, '$getgm', function $$getgm() {
      var self = this;

      
      var result = new Date(self.getTime());
      result.timezone = 0;
      return result;
    
    }, 0);
    
    $def(self, '$gmtime', function $$gmtime() {
      var self = this;

      
      self.timezone = 0;
      return self;
    
    }, 0);
    
    $def(self, '$gmt?', function $Time_gmt$ques$11() {
      var self = this;

      return self.timezone === 0;
    }, 0);
    
    $def(self, '$gmt_offset', function $$gmt_offset() {
      var self = this;

      return (self.timezone != null) ? self.timezone * 60 : -self.getTimezoneOffset() * 60;
    }, 0);
    
    $def(self, '$strftime', function $$strftime(format) {
      var self = this;

      
      return format.replace(/%([\-_#^0]*:{0,2})(\d+)?([EO]*)(.)/g, function(full, flags, width, _, conv) {
        var result = "", jd, c, s,
            zero   = flags.indexOf('0') !== -1,
            pad    = flags.indexOf('-') === -1,
            blank  = flags.indexOf('_') !== -1,
            upcase = flags.indexOf('^') !== -1,
            invert = flags.indexOf('#') !== -1,
            colons = (flags.match(':') || []).length;

        width = parseInt(width, 10);

        if (zero && blank) {
          if (flags.indexOf('0') < flags.indexOf('_')) {
            zero = false;
          }
          else {
            blank = false;
          }
        }

        switch (conv) {
          case 'Y':
            result += self.$year();
            break;

          case 'C':
            zero    = !blank;
            result += Math.round(self.$year() / 100);
            break;

          case 'y':
            zero    = !blank;
            result += (self.$year() % 100);
            break;

          case 'm':
            zero    = !blank;
            result += self.$mon();
            break;

          case 'B':
            result += long_months[self.$mon() - 1];
            break;

          case 'b':
          case 'h':
            blank   = !zero;
            result += short_months[self.$mon() - 1];
            break;

          case 'd':
            zero    = !blank
            result += self.$day();
            break;

          case 'e':
            blank   = !zero
            result += self.$day();
            break;

          case 'j':
            zero    = !blank;
            width   = isNaN(width) ? 3 : width;
            result += self.$yday();
            break;

          case 'H':
            zero    = !blank;
            result += self.$hour();
            break;

          case 'k':
            blank   = !zero;
            result += self.$hour();
            break;

          case 'I':
            zero    = !blank;
            result += (self.$hour() % 12 || 12);
            break;

          case 'l':
            blank   = !zero;
            result += (self.$hour() % 12 || 12);
            break;

          case 'P':
            result += (self.$hour() >= 12 ? "pm" : "am");
            break;

          case 'p':
            result += (self.$hour() >= 12 ? "PM" : "AM");
            break;

          case 'M':
            zero    = !blank;
            result += self.$min();
            break;

          case 'S':
            zero    = !blank;
            result += self.$sec()
            break;

          case 'L':
            zero    = !blank;
            width   = isNaN(width) ? 3 : width;
            result += self.getMilliseconds();
            break;

          case 'N':
            width   = isNaN(width) ? 9 : width;
            result += (self.getMilliseconds().toString()).$rjust(3, "0");
            result  = (result).$ljust(width, "0");
            break;

          case 'z':
            var offset  = (self.timezone == null) ? self.getTimezoneOffset() : (-self.timezone * 60),
                hours   = Math.floor(Math.abs(offset) / 60),
                minutes = Math.abs(offset) % 60;

            result += offset < 0 ? "+" : "-";
            result += hours < 10 ? "0" : "";
            result += hours;

            if (colons > 0) {
              result += ":";
            }

            result += minutes < 10 ? "0" : "";
            result += minutes;

            if (colons > 1) {
              result += ":00";
            }

            break;

          case 'Z':
            result += self.$zone();
            break;

          case 'A':
            result += days_of_week[self.$wday()];
            break;

          case 'a':
            result += short_days[self.$wday()];
            break;

          case 'u':
            result += (self.$wday() + 1);
            break;

          case 'w':
            result += self.$wday();
            break;

          case 'V':
            result += self.$cweek_cyear()['$[]'](0).$to_s().$rjust(2, "0");
            break;

          case 'G':
            result += self.$cweek_cyear()['$[]'](1);
            break;

          case 'g':
            result += self.$cweek_cyear()['$[]'](1)['$[]']($range(-2, -1, false));
            break;

          case 's':
            result += self.$to_i();
            break;

          case 'n':
            result += "\n";
            break;

          case 't':
            result += "\t";
            break;

          case '%':
            result += "%";
            break;

          case 'c':
            result += self.$strftime("%a %b %e %T %Y");
            break;

          case 'D':
          case 'x':
            result += self.$strftime("%m/%d/%y");
            break;

          case 'F':
            result += self.$strftime("%Y-%m-%d");
            break;

          case 'v':
            result += self.$strftime("%e-%^b-%4Y");
            break;

          case 'r':
            result += self.$strftime("%I:%M:%S %p");
            break;

          case 'R':
            result += self.$strftime("%H:%M");
            break;

          case 'T':
          case 'X':
            result += self.$strftime("%H:%M:%S");
            break;

          // Non-standard: JIS X 0301 date format
          case 'J':
            jd = self.$to_date().$jd();
            if (jd < 2405160) {
              result += self.$strftime("%Y-%m-%d");
              break;
            }
            else if (jd < 2419614)
              c = 'M', s = 1867;
            else if (jd < 2424875)
              c = 'T', s = 1911;
            else if (jd < 2447535)
              c = 'S', s = 1925;
            else if (jd < 2458605)
              c = 'H', s = 1988;
            else
              c = 'R', s = 2018;

            result += self.$format("%c%02d", c, $rb_minus(self.$year(), s));
            result += self.$strftime("-%m-%d");
            break;

          default:
            return full;
        }

        if (upcase) {
          result = result.toUpperCase();
        }

        if (invert) {
          result = result.replace(/[A-Z]/, function(c) { c.toLowerCase() }).
                          replace(/[a-z]/, function(c) { c.toUpperCase() });
        }

        if (pad && (zero || blank)) {
          result = (result).$rjust(isNaN(width) ? 2 : width, blank ? " " : "0");
        }

        return result;
      });
    
    }, 1);
    
    $def(self, '$to_a', function $$to_a() {
      var self = this;

      return [self.$sec(), self.$min(), self.$hour(), self.$day(), self.$month(), self.$year(), self.$wday(), self.$yday(), self.$isdst(), self.$zone()]
    }, 0);
    
    $def(self, '$to_f', function $$to_f() {
      var self = this;

      return self.getTime() / 1000;
    }, 0);
    
    $def(self, '$to_i', function $$to_i() {
      var self = this;

      return parseInt(self.getTime() / 1000, 10);
    }, 0);
    
    $def(self, '$cweek_cyear', function $$cweek_cyear() {
      var self = this, jan01 = nil, jan01_wday = nil, first_monday = nil, year = nil, offset = nil, week = nil, dec31 = nil, dec31_wday = nil;

      
      jan01 = $$$('Time').$new(self.$year(), 1, 1);
      jan01_wday = jan01.$wday();
      first_monday = 0;
      year = self.$year();
      if (($truthy($rb_le(jan01_wday, 4)) && ($neqeq(jan01_wday, 0)))) {
        offset = $rb_minus(jan01_wday, 1)
      } else {
        
        offset = $rb_minus($rb_minus(jan01_wday, 7), 1);
        if ($eqeq(offset, -8)) {
          offset = -1
        };
      };
      week = $rb_divide($rb_plus(self.$yday(), offset), 7.0).$ceil();
      if ($truthy($rb_le(week, 0))) {
        return $$$('Time').$new($rb_minus(self.$year(), 1), 12, 31).$cweek_cyear()
      } else if ($eqeq(week, 53)) {
        
        dec31 = $$$('Time').$new(self.$year(), 12, 31);
        dec31_wday = dec31.$wday();
        if (($truthy($rb_le(dec31_wday, 3)) && ($neqeq(dec31_wday, 0)))) {
          
          week = 1;
          year = $rb_plus(year, 1);
        };
      };
      return [week, year];
    }, 0);
    (function(self, $parent_nesting) {
      
      
      $alias(self, "mktime", "local");
      return $alias(self, "utc", "gm");
    })(Opal.get_singleton_class(self), $nesting);
    $alias(self, "ctime", "asctime");
    $alias(self, "dst?", "isdst");
    $alias(self, "getutc", "getgm");
    $alias(self, "gmtoff", "gmt_offset");
    $alias(self, "mday", "day");
    $alias(self, "month", "mon");
    $alias(self, "to_s", "inspect");
    $alias(self, "tv_sec", "to_i");
    $alias(self, "tv_usec", "usec");
    $alias(self, "utc", "gmtime");
    $alias(self, "utc?", "gmt?");
    return $alias(self, "utc_offset", "gmt_offset");
  })('::', Date, $nesting);
};

Opal.modules["corelib/struct"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $hash2 = Opal.hash2, $truthy = Opal.truthy, $neqeq = Opal.neqeq, $eqeq = Opal.eqeq, $Opal = Opal.Opal, $send = Opal.send, $Class = Opal.Class, $to_a = Opal.to_a, $def = Opal.def, $defs = Opal.defs, $Kernel = Opal.Kernel, $rb_gt = Opal.rb_gt, $rb_minus = Opal.rb_minus, $eqeqeq = Opal.eqeqeq, $rb_lt = Opal.rb_lt, $rb_ge = Opal.rb_ge, $rb_plus = Opal.rb_plus, $alias = Opal.alias;

  Opal.add_stubs('require,include,!=,upcase,[],==,class,unshift,const_name!,map,coerce_to!,new,each,define_struct_attribute,allocate,initialize,alias_method,module_eval,to_proc,const_set,raise,<<,members,define_method,instance_eval,last,>,length,-,keys,any?,join,[]=,each_with_index,hash,===,<,-@,size,>=,include?,to_sym,instance_of?,__id__,eql?,enum_for,+,name,each_pair,inspect,to_h,args,each_with_object,flatten,to_a,respond_to?,dig');
  
  self.$require("corelib/enumerable");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Struct');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    self.$include($$$('Enumerable'));
    $defs(self, '$new', function $Struct_new$1(const_name, $a, $b) {
      var block = $Struct_new$1.$$p || nil, $post_args, $kwargs, args, keyword_init, self = this, klass = nil;

      delete $Struct_new$1.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      $kwargs = Opal.extract_kwargs($post_args);
      
      if ($kwargs == null) {
        $kwargs = $hash2([], {});
      } else if (!$kwargs.$$is_hash) {
        throw Opal.ArgumentError.$new('expected kwargs');
      };
      
      args = $post_args;;
      
      keyword_init = $kwargs.$$smap["keyword_init"];
      if (keyword_init == null) keyword_init = false;
      if ($truthy(const_name)) {
        if (($eqeq(const_name.$class(), $$$('String')) && ($neqeq(const_name['$[]'](0).$upcase(), const_name['$[]'](0))))) {
          
          args.$unshift(const_name);
          const_name = nil;
        } else {
          
          try {
            const_name = $Opal['$const_name!'](const_name)
          } catch ($err) {
            if (Opal.rescue($err, [$$$('TypeError'), $$$('NameError')])) {
              try {
                
                args.$unshift(const_name);
                const_name = nil;
              } finally { Opal.pop_exception(); }
            } else { throw $err; }
          };
        }
      };
      $send(args, 'map', [], function $$2(arg){
        
        
        if (arg == null) arg = nil;;
        return $Opal['$coerce_to!'](arg, $$$('String'), "to_str");}, 1);
      klass = $send($Class, 'new', [self], function $$3(){var self = $$3.$$s == null ? this : $$3.$$s;

        
        $send(args, 'each', [], function $$4(arg){var self = $$4.$$s == null ? this : $$4.$$s;

          
          
          if (arg == null) arg = nil;;
          return self.$define_struct_attribute(arg);}, {$$arity: 1, $$s: self});
        return (function(self, $parent_nesting) {
          
          
          
          $def(self, '$new', function $new$5($a) {
            var $post_args, args, self = this, instance = nil;

            
            
            $post_args = Opal.slice.call(arguments);
            
            args = $post_args;;
            instance = self.$allocate();
            instance.$$data = {};
            $send(instance, 'initialize', $to_a(args));
            return instance;
          }, -1);
          return self.$alias_method("[]", "new");
        })(Opal.get_singleton_class(self), $nesting);}, {$$arity: 0, $$s: self});
      if ($truthy(block)) {
        $send(klass, 'module_eval', [], block.$to_proc())
      };
      klass.$$keyword_init = keyword_init;
      if ($truthy(const_name)) {
        $$$('Struct').$const_set(const_name, klass)
      };
      return klass;
    }, -2);
    $defs(self, '$define_struct_attribute', function $$define_struct_attribute(name) {
      var self = this;

      
      if ($eqeq(self, $$$('Struct'))) {
        $Kernel.$raise($$$('ArgumentError'), "you cannot define attributes to the Struct class")
      };
      self.$members()['$<<'](name);
      $send(self, 'define_method', [name], function $$6(){var self = $$6.$$s == null ? this : $$6.$$s;

        return self.$$data[name];}, {$$arity: 0, $$s: self});
      return $send(self, 'define_method', ["" + (name) + "="], function $$7(value){var self = $$7.$$s == null ? this : $$7.$$s;

        
        
        if (value == null) value = nil;;
        return self.$$data[name] = value;;}, {$$arity: 1, $$s: self});
    }, 1);
    $defs(self, '$members', function $$members() {
      var self = this, $ret_or_1 = nil;
      if (self.members == null) self.members = nil;

      
      if ($eqeq(self, $$$('Struct'))) {
        $Kernel.$raise($$$('ArgumentError'), "the Struct class has no members")
      };
      return (self.members = ($truthy(($ret_or_1 = self.members)) ? ($ret_or_1) : ([])));
    }, 0);
    $defs(self, '$inherited', function $$inherited(klass) {
      var self = this, members = nil;
      if (self.members == null) self.members = nil;

      
      members = self.members;
      return $send(klass, 'instance_eval', [], function $$8(){var self = $$8.$$s == null ? this : $$8.$$s;

        return (self.members = members)}, {$$arity: 0, $$s: self});
    }, 1);
    
    $def(self, '$initialize', function $$initialize($a) {
      var $post_args, args, self = this, kwargs = nil, $ret_or_1 = nil, extra = nil;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if ($truthy(self.$class().$$keyword_init)) {
        
        kwargs = ($truthy(($ret_or_1 = args.$last())) ? ($ret_or_1) : ($hash2([], {})));
        if (($truthy($rb_gt(args.$length(), 1)) || ($truthy((args.length === 1 && !kwargs.$$is_hash))))) {
          $Kernel.$raise($$$('ArgumentError'), "wrong number of arguments (given " + (args.$length()) + ", expected 0)")
        };
        extra = $rb_minus(kwargs.$keys(), self.$class().$members());
        if ($truthy(extra['$any?']())) {
          $Kernel.$raise($$$('ArgumentError'), "unknown keywords: " + (extra.$join(", ")))
        };
        return $send(self.$class().$members(), 'each', [], function $$9(name){var $b, self = $$9.$$s == null ? this : $$9.$$s;

          
          
          if (name == null) name = nil;;
          return ($b = [name, kwargs['$[]'](name)], $send(self, '[]=', $b), $b[$b.length - 1]);}, {$$arity: 1, $$s: self});
      } else {
        
        if ($truthy($rb_gt(args.$length(), self.$class().$members().$length()))) {
          $Kernel.$raise($$$('ArgumentError'), "struct size differs")
        };
        return $send(self.$class().$members(), 'each_with_index', [], function $$10(name, index){var $b, self = $$10.$$s == null ? this : $$10.$$s;

          
          
          if (name == null) name = nil;;
          
          if (index == null) index = nil;;
          return ($b = [name, args['$[]'](index)], $send(self, '[]=', $b), $b[$b.length - 1]);}, {$$arity: 2, $$s: self});
      };
    }, -1);
    
    $def(self, '$initialize_copy', function $$initialize_copy(from) {
      var self = this;

      
      self.$$data = {}
      var keys = Object.keys(from.$$data), i, max, name;
      for (i = 0, max = keys.length; i < max; i++) {
        name = keys[i];
        self.$$data[name] = from.$$data[name];
      }
    
    }, 1);
    $defs(self, '$keyword_init?', function $Struct_keyword_init$ques$11() {
      var self = this;

      return self.$$keyword_init;
    }, 0);
    
    $def(self, '$members', function $$members() {
      var self = this;

      return self.$class().$members()
    }, 0);
    
    $def(self, '$hash', function $$hash() {
      var self = this;

      return $$('Hash').$new(self.$$data).$hash()
    }, 0);
    
    $def(self, '$[]', function $Struct_$$$12(name) {
      var self = this;

      
      if ($eqeqeq($$$('Integer'), name)) {
        
        if ($truthy($rb_lt(name, self.$class().$members().$size()['$-@']()))) {
          $Kernel.$raise($$$('IndexError'), "offset " + (name) + " too small for struct(size:" + (self.$class().$members().$size()) + ")")
        };
        if ($truthy($rb_ge(name, self.$class().$members().$size()))) {
          $Kernel.$raise($$$('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$class().$members().$size()) + ")")
        };
        name = self.$class().$members()['$[]'](name);
      } else if ($eqeqeq($$$('String'), name)) {
        
        if(!self.$$data.hasOwnProperty(name)) {
          $Kernel.$raise($$$('NameError').$new("no member '" + (name) + "' in struct", name))
        }
      
      } else {
        $Kernel.$raise($$$('TypeError'), "no implicit conversion of " + (name.$class()) + " into Integer")
      };
      name = $Opal['$coerce_to!'](name, $$$('String'), "to_str");
      return self.$$data[name];;
    }, 1);
    
    $def(self, '$[]=', function $Struct_$$$eq$13(name, value) {
      var self = this;

      
      if ($eqeqeq($$$('Integer'), name)) {
        
        if ($truthy($rb_lt(name, self.$class().$members().$size()['$-@']()))) {
          $Kernel.$raise($$$('IndexError'), "offset " + (name) + " too small for struct(size:" + (self.$class().$members().$size()) + ")")
        };
        if ($truthy($rb_ge(name, self.$class().$members().$size()))) {
          $Kernel.$raise($$$('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$class().$members().$size()) + ")")
        };
        name = self.$class().$members()['$[]'](name);
      } else if ($eqeqeq($$$('String'), name)) {
        if (!$truthy(self.$class().$members()['$include?'](name.$to_sym()))) {
          $Kernel.$raise($$$('NameError').$new("no member '" + (name) + "' in struct", name))
        }
      } else {
        $Kernel.$raise($$$('TypeError'), "no implicit conversion of " + (name.$class()) + " into Integer")
      };
      name = $Opal['$coerce_to!'](name, $$$('String'), "to_str");
      return self.$$data[name] = value;;
    }, 2);
    
    $def(self, '$==', function $Struct_$eq_eq$14(other) {
      var self = this;

      
      if (!$truthy(other['$instance_of?'](self.$class()))) {
        return false
      };
      
      var recursed1 = {}, recursed2 = {};

      function _eqeq(struct, other) {
        var key, a, b;

        recursed1[(struct).$__id__()] = true;
        recursed2[(other).$__id__()] = true;

        for (key in struct.$$data) {
          a = struct.$$data[key];
          b = other.$$data[key];

          if ($$$('Struct')['$==='](a)) {
            if (!recursed1.hasOwnProperty((a).$__id__()) || !recursed2.hasOwnProperty((b).$__id__())) {
              if (!_eqeq(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$=='](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eqeq(self, other);
    ;
    }, 1);
    
    $def(self, '$eql?', function $Struct_eql$ques$15(other) {
      var self = this;

      
      if (!$truthy(other['$instance_of?'](self.$class()))) {
        return false
      };
      
      var recursed1 = {}, recursed2 = {};

      function _eqeq(struct, other) {
        var key, a, b;

        recursed1[(struct).$__id__()] = true;
        recursed2[(other).$__id__()] = true;

        for (key in struct.$$data) {
          a = struct.$$data[key];
          b = other.$$data[key];

          if ($$$('Struct')['$==='](a)) {
            if (!recursed1.hasOwnProperty((a).$__id__()) || !recursed2.hasOwnProperty((b).$__id__())) {
              if (!_eqeq(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$eql?'](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eqeq(self, other);
    ;
    }, 1);
    
    $def(self, '$each', function $$each() {
      var $yield = $$each.$$p || nil, self = this;

      delete $$each.$$p;
      
      if (!($yield !== nil)) {
        return $send(self, 'enum_for', ["each"], function $$16(){var self = $$16.$$s == null ? this : $$16.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      $send(self.$class().$members(), 'each', [], function $$17(name){var self = $$17.$$s == null ? this : $$17.$$s;

        
        
        if (name == null) name = nil;;
        return Opal.yield1($yield, self['$[]'](name));;}, {$$arity: 1, $$s: self});
      return self;
    }, 0);
    
    $def(self, '$each_pair', function $$each_pair() {
      var $yield = $$each_pair.$$p || nil, self = this;

      delete $$each_pair.$$p;
      
      if (!($yield !== nil)) {
        return $send(self, 'enum_for', ["each_pair"], function $$18(){var self = $$18.$$s == null ? this : $$18.$$s;

          return self.$size()}, {$$arity: 0, $$s: self})
      };
      $send(self.$class().$members(), 'each', [], function $$19(name){var self = $$19.$$s == null ? this : $$19.$$s;

        
        
        if (name == null) name = nil;;
        return Opal.yield1($yield, [name, self['$[]'](name)]);;}, {$$arity: 1, $$s: self});
      return self;
    }, 0);
    
    $def(self, '$length', function $$length() {
      var self = this;

      return self.$class().$members().$length()
    }, 0);
    
    $def(self, '$to_a', function $$to_a() {
      var self = this;

      return $send(self.$class().$members(), 'map', [], function $$20(name){var self = $$20.$$s == null ? this : $$20.$$s;

        
        
        if (name == null) name = nil;;
        return self['$[]'](name);}, {$$arity: 1, $$s: self})
    }, 0);
    var inspect_stack = [];
    
    $def(self, '$inspect', function $$inspect() {
      var self = this, result = nil, pushed = nil;

      return (function() { try {
      
      result = "#<struct ";
      if ($truthy((inspect_stack)['$include?'](self.$__id__()))) {
        return $rb_plus(result, ":...>")
      } else {
        
        (inspect_stack)['$<<'](self.$__id__());
        pushed = true;
        if (($eqeqeq($$$('Struct'), self) && ($truthy(self.$class().$name())))) {
          result = $rb_plus(result, "" + (self.$class()) + " ")
        };
        result = $rb_plus(result, $send(self.$each_pair(), 'map', [], function $$21(name, value){
          
          
          if (name == null) name = nil;;
          
          if (value == null) value = nil;;
          return "" + (name) + "=" + ($$('Opal').$inspect(value));}, 2).$join(", "));
        result = $rb_plus(result, ">");
        return result;
      };
      } finally {
        ($truthy(pushed) ? (inspect_stack.pop()) : nil)
      }; })()
    }, 0);
    
    $def(self, '$to_h', function $$to_h() {
      var block = $$to_h.$$p || nil, self = this;

      delete $$to_h.$$p;
      
      ;
      if ((block !== nil)) {
        return $send($send(self, 'map', [], block.$to_proc()), 'to_h', $to_a(self.$args()))
      };
      return $send(self.$class().$members(), 'each_with_object', [$hash2([], {})], function $$22(name, h){var $a, self = $$22.$$s == null ? this : $$22.$$s;

        
        
        if (name == null) name = nil;;
        
        if (h == null) h = nil;;
        return ($a = [name, self['$[]'](name)], $send(h, '[]=', $a), $a[$a.length - 1]);}, {$$arity: 2, $$s: self});
    }, 0);
    
    $def(self, '$values_at', function $$values_at($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      args = $send(args, 'map', [], function $$23(arg){
        
        
        if (arg == null) arg = nil;;
        return arg.$$is_range ? arg.$to_a() : arg;}, 1).$flatten();
      
      var result = [];
      for (var i = 0, len = args.length; i < len; i++) {
        if (!args[i].$$is_number) {
          $Kernel.$raise($$$('TypeError'), "no implicit conversion of " + ((args[i]).$class()) + " into Integer")
        }
        result.push(self['$[]'](args[i]));
      }
      return result;
    ;
    }, -1);
    
    $def(self, '$dig', function $$dig(key, $a) {
      var $post_args, keys, self = this, item = nil;

      
      
      $post_args = Opal.slice.call(arguments, 1);
      
      keys = $post_args;;
      item = ($truthy(key.$$is_string && self.$$data.hasOwnProperty(key)) ? (self.$$data[key] || nil) : nil);
      
      if (item === nil || keys.length === 0) {
        return item;
      }
    ;
      if (!$truthy(item['$respond_to?']("dig"))) {
        $Kernel.$raise($$$('TypeError'), "" + (item.$class()) + " does not have #dig method")
      };
      return $send(item, 'dig', $to_a(keys));
    }, -2);
    $alias(self, "size", "length");
    $alias(self, "to_s", "inspect");
    return $alias(self, "values", "to_a");
  })('::', null, $nesting);
};

Opal.modules["corelib/dir"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $def = Opal.def, $truthy = Opal.truthy, $alias = Opal.alias;

  Opal.add_stubs('[],pwd');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Dir');

    var $nesting = [self].concat($parent_nesting);

    return (function(self, $parent_nesting) {
      
      
      
      $def(self, '$chdir', function $$chdir(dir) {
        var $yield = $$chdir.$$p || nil, prev_cwd = nil;

        delete $$chdir.$$p;
        return (function() { try {
        
        prev_cwd = Opal.current_dir;
        Opal.current_dir = dir;
        return Opal.yieldX($yield, []);;
        } finally {
          Opal.current_dir = prev_cwd
        }; })()
      }, 1);
      
      $def(self, '$pwd', function $$pwd() {
        
        return Opal.current_dir || '.';
      }, 0);
      
      $def(self, '$home', function $$home() {
        var $ret_or_1 = nil;

        if ($truthy(($ret_or_1 = $$$('ENV')['$[]']("HOME")))) {
          return $ret_or_1
        } else {
          return "."
        }
      }, 0);
      return $alias(self, "getwd", "pwd");
    })(Opal.get_singleton_class(self), $nesting)
  })('::', null, $nesting)
};

Opal.modules["corelib/file"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $klass = Opal.klass, $const_set = Opal.const_set, $Opal = Opal.Opal, $regexp = Opal.regexp, $rb_plus = Opal.rb_plus, $def = Opal.def, $Kernel = Opal.Kernel, $eqeq = Opal.eqeq, $rb_lt = Opal.rb_lt, $rb_minus = Opal.rb_minus, $range = Opal.range, $send = Opal.send, $alias = Opal.alias;

  Opal.add_stubs('respond_to?,to_path,coerce_to!,pwd,split,sub,+,unshift,join,home,raise,start_with?,absolute_path,==,<,dirname,-,basename,empty?,rindex,[],length,nil?,gsub,find,=~,map,each_with_index,flatten,reject,to_proc,end_with?,expand_path,exist?');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'File');

    var $nesting = [self].concat($parent_nesting), windows_root_rx = nil;

    
    $const_set($nesting[0], 'Separator', $const_set($nesting[0], 'SEPARATOR', "/"));
    $const_set($nesting[0], 'ALT_SEPARATOR', nil);
    $const_set($nesting[0], 'PATH_SEPARATOR', ":");
    $const_set($nesting[0], 'FNM_SYSCASE', 0);
    windows_root_rx = /^[a-zA-Z]:(?:\\|\/)/;
    return (function(self, $parent_nesting) {
      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      
      $def(self, '$absolute_path', function $$absolute_path(path, basedir) {
        var sep = nil, sep_chars = nil, new_parts = nil, $ret_or_1 = nil, path_abs = nil, basedir_abs = nil, parts = nil, leading_sep = nil, abs = nil, new_path = nil;

        
        
        if (basedir == null) basedir = nil;;
        sep = $$('SEPARATOR');
        sep_chars = $sep_chars();
        new_parts = [];
        path = ($truthy(path['$respond_to?']("to_path")) ? (path.$to_path()) : (path));
        path = $Opal['$coerce_to!'](path, $$$('String'), "to_str");
        basedir = ($truthy(($ret_or_1 = basedir)) ? ($ret_or_1) : ($$$('Dir').$pwd()));
        path_abs = path.substr(0, sep.length) === sep || windows_root_rx.test(path);
        basedir_abs = basedir.substr(0, sep.length) === sep || windows_root_rx.test(basedir);
        if ($truthy(path_abs)) {
          
          parts = path.$split($regexp(["[", sep_chars, "]"]));
          leading_sep = windows_root_rx.test(path) ? '' : path.$sub($regexp(["^([", sep_chars, "]+).*$"]), "\\1");
          abs = true;
        } else {
          
          parts = $rb_plus(basedir.$split($regexp(["[", sep_chars, "]"])), path.$split($regexp(["[", sep_chars, "]"])));
          leading_sep = windows_root_rx.test(basedir) ? '' : basedir.$sub($regexp(["^([", sep_chars, "]+).*$"]), "\\1");
          abs = basedir_abs;
        };
        
        var part;
        for (var i = 0, ii = parts.length; i < ii; i++) {
          part = parts[i];

          if (
            (part === nil) ||
            (part === ''  && ((new_parts.length === 0) || abs)) ||
            (part === '.' && ((new_parts.length === 0) || abs))
          ) {
            continue;
          }
          if (part === '..') {
            new_parts.pop();
          } else {
            new_parts.push(part);
          }
        }

        if (!abs && parts[0] !== '.') {
          new_parts.$unshift(".")
        }
      ;
        new_path = new_parts.$join(sep);
        if ($truthy(abs)) {
          new_path = $rb_plus(leading_sep, new_path)
        };
        return new_path;
      }, -2);
      
      $def(self, '$expand_path', function $$expand_path(path, basedir) {
        var self = this, sep = nil, sep_chars = nil, home = nil, leading_sep = nil, home_path_regexp = nil;

        
        
        if (basedir == null) basedir = nil;;
        sep = $$('SEPARATOR');
        sep_chars = $sep_chars();
        if ($truthy(path[0] === '~' || (basedir && basedir[0] === '~'))) {
          
          home = $$('Dir').$home();
          if (!$truthy(home)) {
            $Kernel.$raise($$$('ArgumentError'), "couldn't find HOME environment -- expanding `~'")
          };
          leading_sep = windows_root_rx.test(home) ? '' : home.$sub($regexp(["^([", sep_chars, "]+).*$"]), "\\1");
          if (!$truthy(home['$start_with?'](leading_sep))) {
            $Kernel.$raise($$$('ArgumentError'), "non-absolute home")
          };
          home = $rb_plus(home, sep);
          home_path_regexp = $regexp(["^\\~(?:", sep, "|$)"]);
          path = path.$sub(home_path_regexp, home);
          if ($truthy(basedir)) {
            basedir = basedir.$sub(home_path_regexp, home)
          };
        };
        return self.$absolute_path(path, basedir);
      }, -2);
      
      // Coerce a given path to a path string using #to_path and #to_str
      function $coerce_to_path(path) {
        if ($truthy((path)['$respond_to?']("to_path"))) {
          path = path.$to_path();
        }

        path = $Opal['$coerce_to!'](path, $$$('String'), "to_str");

        return path;
      }

      // Return a RegExp compatible char class
      function $sep_chars() {
        if ($$('ALT_SEPARATOR') === nil) {
          return Opal.escape_regexp($$('SEPARATOR'));
        } else {
          return Opal.escape_regexp($rb_plus($$('SEPARATOR'), $$('ALT_SEPARATOR')));
        }
      }
    ;
      
      $def(self, '$dirname', function $$dirname(path, level) {
        var self = this, sep_chars = nil;

        
        
        if (level == null) level = 1;;
        if ($eqeq(level, 0)) {
          return path
        };
        if ($truthy($rb_lt(level, 0))) {
          $Kernel.$raise($$$('ArgumentError'), "level can't be negative")
        };
        sep_chars = $sep_chars();
        path = $coerce_to_path(path);
        
        var absolute = path.match(new RegExp("^[" + (sep_chars) + "]")), out;

        path = path.replace(new RegExp("[" + (sep_chars) + "]+$"), ''); // remove trailing separators
        path = path.replace(new RegExp("[^" + (sep_chars) + "]+$"), ''); // remove trailing basename
        path = path.replace(new RegExp("[" + (sep_chars) + "]+$"), ''); // remove final trailing separators

        if (path === '') {
          out = absolute ? '/' : '.';
        }
        else {
          out = path;
        }

        if (level == 1) {
          return out;
        }
        else {
          return self.$dirname(out, $rb_minus(level, 1))
        }
      ;
      }, -2);
      
      $def(self, '$basename', function $$basename(name, suffix) {
        var sep_chars = nil;

        
        
        if (suffix == null) suffix = nil;;
        sep_chars = $sep_chars();
        name = $coerce_to_path(name);
        
        if (name.length == 0) {
          return name;
        }

        if (suffix !== nil) {
          suffix = $Opal['$coerce_to!'](suffix, $$$('String'), "to_str")
        } else {
          suffix = null;
        }

        name = name.replace(new RegExp("(.)[" + (sep_chars) + "]*$"), '$1');
        name = name.replace(new RegExp("^(?:.*[" + (sep_chars) + "])?([^" + (sep_chars) + "]+)$"), '$1');

        if (suffix === ".*") {
          name = name.replace(/\.[^\.]+$/, '');
        } else if(suffix !== null) {
          suffix = Opal.escape_regexp(suffix);
          name = name.replace(new RegExp("" + (suffix) + "$"), '');
        }

        return name;
      ;
      }, -2);
      
      $def(self, '$extname', function $$extname(path) {
        var self = this, filename = nil, last_dot_idx = nil;

        
        path = $coerce_to_path(path);
        filename = self.$basename(path);
        if ($truthy(filename['$empty?']())) {
          return ""
        };
        last_dot_idx = filename['$[]']($range(1, -1, false)).$rindex(".");
        if (($truthy(last_dot_idx['$nil?']()) || ($eqeq($rb_plus(last_dot_idx, 1), $rb_minus(filename.$length(), 1))))) {
          return ""
        } else {
          return filename['$[]'](Opal.Range.$new($rb_plus(last_dot_idx, 1), -1, false))
        };
      }, 1);
      
      $def(self, '$exist?', function $exist$ques$1(path) {
        
        return Opal.modules[path] != null
      }, 1);
      
      $def(self, '$directory?', function $directory$ques$2(path) {
        var files = nil, file = nil;

        
        files = [];
        
        for (var key in Opal.modules) {
          files.push(key)
        }
      ;
        path = path.$gsub($regexp(["(^.", $$('SEPARATOR'), "+|", $$('SEPARATOR'), "+$)"]));
        file = $send(files, 'find', [], function $$3(f){
          
          
          if (f == null) f = nil;;
          return f['$=~']($regexp(["^", path]));}, 1);
        return file;
      }, 1);
      
      $def(self, '$join', function $$join($a) {
        var $post_args, paths, result = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        paths = $post_args;;
        if ($truthy(paths['$empty?']())) {
          return ""
        };
        result = "";
        paths = $send(paths.$flatten().$each_with_index(), 'map', [], function $$4(item, index){
          
          
          if (item == null) item = nil;;
          
          if (index == null) index = nil;;
          if (($eqeq(index, 0) && ($truthy(item['$empty?']())))) {
            return $$('SEPARATOR')
          } else if (($eqeq(paths.$length(), $rb_plus(index, 1)) && ($truthy(item['$empty?']())))) {
            return $$('SEPARATOR')
          } else {
            return item
          };}, 2);
        paths = $send(paths, 'reject', [], "empty?".$to_proc());
        $send(paths, 'each_with_index', [], function $$5(item, index){var next_item = nil;

          
          
          if (item == null) item = nil;;
          
          if (index == null) index = nil;;
          next_item = paths['$[]']($rb_plus(index, 1));
          if ($truthy(next_item['$nil?']())) {
            return (result = "" + (result) + (item))
          } else {
            
            if (($truthy(item['$end_with?']($$('SEPARATOR'))) && ($truthy(next_item['$start_with?']($$('SEPARATOR')))))) {
              item = item.$sub($regexp([$$('SEPARATOR'), "+$"]), "")
            };
            return (result = (($truthy(item['$end_with?']($$('SEPARATOR'))) || ($truthy(next_item['$start_with?']($$('SEPARATOR'))))) ? ("" + (result) + (item)) : ("" + (result) + (item) + ($$('SEPARATOR')))));
          };}, 2);
        return result;
      }, -1);
      
      $def(self, '$split', function $$split(path) {
        
        return path.$split($$('SEPARATOR'))
      }, 1);
      $alias(self, "realpath", "expand_path");
      return $alias(self, "exists?", "exist?");
    })(Opal.get_singleton_class(self), $nesting);
  })('::', $$$('IO'), $nesting)
};

Opal.modules["corelib/process/base"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $klass = Opal.klass, $defs = Opal.defs, $return_val = Opal.return_val;

  
  (function($base, $super) {
    var self = $klass($base, $super, 'Signal');

    
    return $defs(self, '$trap', function $$trap($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1)
  })('::', null);
  return (function($base, $super) {
    var self = $klass($base, $super, 'GC');

    
    return $defs(self, '$start', $return_val(nil), 0)
  })('::', null);
};

Opal.modules["corelib/process"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $defs = Opal.defs, $truthy = Opal.truthy, $return_val = Opal.return_val, $Kernel = Opal.Kernel;

  Opal.add_stubs('const_set,size,<<,__register_clock__,to_f,now,new,[],raise');
  return (function($base) {
    var self = $module($base, 'Process');

    var monotonic = nil;

    
    self.__clocks__ = [];
    $defs(self, '$__register_clock__', function $$__register_clock__(name, func) {
      var self = this;
      if (self.__clocks__ == null) self.__clocks__ = nil;

      
      self.$const_set(name, self.__clocks__.$size());
      return self.__clocks__['$<<'](func);
    }, 2);
    self.$__register_clock__("CLOCK_REALTIME", function() { return Date.now() });
    monotonic = false;
    
    if (Opal.global.performance) {
      monotonic = function() {
        return performance.now()
      };
    }
    else if (Opal.global.process && process.hrtime) {
      // let now be the base to get smaller numbers
      var hrtime_base = process.hrtime();

      monotonic = function() {
        var hrtime = process.hrtime(hrtime_base);
        var us = (hrtime[1] / 1000) | 0; // cut below microsecs;
        return ((hrtime[0] * 1000) + (us / 1000));
      };
    }
  ;
    if ($truthy(monotonic)) {
      self.$__register_clock__("CLOCK_MONOTONIC", monotonic)
    };
    $defs(self, '$pid', $return_val(0), 0);
    $defs(self, '$times', function $$times() {
      var t = nil;

      
      t = $$$('Time').$now().$to_f();
      return $$$($$$('Benchmark'), 'Tms').$new(t, t, t, t, t);
    }, 0);
    return $defs(self, '$clock_gettime', function $$clock_gettime(clock_id, unit) {
      var self = this, $ret_or_1 = nil, clock = nil;
      if (self.__clocks__ == null) self.__clocks__ = nil;

      
      
      if (unit == null) unit = "float_second";;
      if ($truthy(($ret_or_1 = (clock = self.__clocks__['$[]'](clock_id))))) {
        $ret_or_1
      } else {
        $Kernel.$raise($$$($$$('Errno'), 'EINVAL'), "clock_gettime(" + (clock_id) + ") " + (self.__clocks__['$[]'](clock_id)))
      };
      
      var ms = clock();
      switch (unit) {
        case 'float_second':      return  (ms / 1000);         // number of seconds as a float (default)
        case 'float_millisecond': return  (ms / 1);            // number of milliseconds as a float
        case 'float_microsecond': return  (ms * 1000);         // number of microseconds as a float
        case 'second':            return ((ms / 1000)    | 0); // number of seconds as an integer
        case 'millisecond':       return ((ms / 1)       | 0); // number of milliseconds as an integer
        case 'microsecond':       return ((ms * 1000)    | 0); // number of microseconds as an integer
        case 'nanosecond':        return ((ms * 1000000) | 0); // number of nanoseconds as an integer
        default: $Kernel.$raise($$$('ArgumentError'), "unexpected unit: " + (unit))
      }
    ;
    }, -2);
  })('::')
};

Opal.modules["corelib/random/formatter"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $module = Opal.module, $def = Opal.def, $range = Opal.range, $send = Opal.send, $rb_divide = Opal.rb_divide, $Kernel = Opal.Kernel, $Opal = Opal.Opal;

  Opal.add_stubs('_verify_count,bytes,encode,strict_encode64,random_bytes,urlsafe_encode64,split,hex,[]=,[],map,to_proc,join,times,<<,|,ord,/,abs,random_float,raise,coerce_to!,flatten,new,random_number,length,include,extend');
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Random');

    var $nesting = [self].concat($parent_nesting);

    
    (function($base, $parent_nesting) {
      var self = $module($base, 'Formatter');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      
      $def(self, '$hex', function $$hex(count) {
        var self = this;

        
        
        if (count == null) count = nil;;
        count = $$$('Random').$_verify_count(count);
        
        var bytes = self.$bytes(count);
        var out = "";
        for (var i = 0; i < count; i++) {
          out += bytes.charCodeAt(i).toString(16).padStart(2, '0');
        }
        return (out).$encode("US-ASCII");
      ;
      }, -1);
      
      $def(self, '$random_bytes', function $$random_bytes(count) {
        var self = this;

        
        
        if (count == null) count = nil;;
        return self.$bytes(count);
      }, -1);
      
      $def(self, '$base64', function $$base64(count) {
        var self = this;

        
        
        if (count == null) count = nil;;
        return $$$('Base64').$strict_encode64(self.$random_bytes(count)).$encode("US-ASCII");
      }, -1);
      
      $def(self, '$urlsafe_base64', function $$urlsafe_base64(count, padding) {
        var self = this;

        
        
        if (count == null) count = nil;;
        
        if (padding == null) padding = false;;
        return $$$('Base64').$urlsafe_encode64(self.$random_bytes(count), padding).$encode("US-ASCII");
      }, -1);
      
      $def(self, '$uuid', function $$uuid() {
        var self = this, str = nil;

        
        str = self.$hex(16).$split("");
        str['$[]='](12, "4");
        str['$[]='](16, (parseInt(str['$[]'](16), 16) & 3 | 8).toString(16));
        str = [str['$[]']($range(0, 8, true)), str['$[]']($range(8, 12, true)), str['$[]']($range(12, 16, true)), str['$[]']($range(16, 20, true)), str['$[]']($range(20, 32, true))];
        str = $send(str, 'map', [], "join".$to_proc());
        return str.$join("-");
      }, 0);
      
      $def(self, '$random_float', function $$random_float() {
        var self = this, bs = nil, num = nil;

        
        bs = self.$bytes(4);
        num = 0;
        $send((4), 'times', [], function $$1(i){
          
          
          if (i == null) i = nil;;
          num = num['$<<'](8);
          return (num = num['$|'](bs['$[]'](i).$ord()));}, 1);
        return $rb_divide(num.$abs(), 2147483647);
      }, 0);
      
      $def(self, '$random_number', function $$random_number(limit) {
        var self = this;

        
        ;
        
        function randomFloat() {
          return self.$random_float();
        }

        function randomInt(max) {
          return Math.floor(randomFloat() * max);
        }

        function randomRange() {
          var min = limit.begin,
              max = limit.end;

          if (min === nil || max === nil) {
            return nil;
          }

          var length = max - min;

          if (length < 0) {
            return nil;
          }

          if (length === 0) {
            return min;
          }

          if (max % 1 === 0 && min % 1 === 0 && !limit.excl) {
            length++;
          }

          return randomInt(length) + min;
        }

        if (limit == null) {
          return randomFloat();
        } else if (limit.$$is_range) {
          return randomRange();
        } else if (limit.$$is_number) {
          if (limit <= 0) {
            $Kernel.$raise($$$('ArgumentError'), "invalid argument - " + (limit))
          }

          if (limit % 1 === 0) {
            // integer
            return randomInt(limit);
          } else {
            return randomFloat() * limit;
          }
        } else {
          limit = $Opal['$coerce_to!'](limit, $$$('Integer'), "to_int");

          if (limit <= 0) {
            $Kernel.$raise($$$('ArgumentError'), "invalid argument - " + (limit))
          }

          return randomInt(limit);
        }
      ;
      }, -1);
      return $def(self, '$alphanumeric', function $$alphanumeric(count) {
        var self = this, map = nil;

        
        
        if (count == null) count = nil;;
        count = $$('Random').$_verify_count(count);
        map = $send([$range("0", "9", false), $range("a", "z", false), $range("A", "Z", false)], 'map', [], "to_a".$to_proc()).$flatten();
        return $send($$$('Array'), 'new', [count], function $$2(i){var self = $$2.$$s == null ? this : $$2.$$s;

          
          
          if (i == null) i = nil;;
          return map['$[]'](self.$random_number(map.$length()));}, {$$arity: 1, $$s: self}).$join();
      }, -1);
    })(self, $nesting);
    self.$include($$$($$$('Random'), 'Formatter'));
    return self.$extend($$$($$$('Random'), 'Formatter'));
  })('::', null, $nesting)
};

Opal.modules["corelib/random/mersenne_twister"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $const_set = Opal.const_set, $send = Opal.send, mersenne_twister = nil;

  Opal.add_stubs('generator=');
  
  mersenne_twister = (function() {
  /* Period parameters */
  var N = 624;
  var M = 397;
  var MATRIX_A = 0x9908b0df;      /* constant vector a */
  var UMASK = 0x80000000;         /* most significant w-r bits */
  var LMASK = 0x7fffffff;         /* least significant r bits */
  var MIXBITS = function(u,v) { return ( ((u) & UMASK) | ((v) & LMASK) ); };
  var TWIST = function(u,v) { return (MIXBITS((u),(v)) >>> 1) ^ ((v & 0x1) ? MATRIX_A : 0x0); };

  function init(s) {
    var mt = {left: 0, next: N, state: new Array(N)};
    init_genrand(mt, s);
    return mt;
  }

  /* initializes mt[N] with a seed */
  function init_genrand(mt, s) {
    var j, i;
    mt.state[0] = s >>> 0;
    for (j=1; j<N; j++) {
      mt.state[j] = (1812433253 * ((mt.state[j-1] ^ (mt.state[j-1] >> 30) >>> 0)) + j);
      /* See Knuth TAOCP Vol2. 3rd Ed. P.106 for multiplier. */
      /* In the previous versions, MSBs of the seed affect   */
      /* only MSBs of the array state[].                     */
      /* 2002/01/09 modified by Makoto Matsumoto             */
      mt.state[j] &= 0xffffffff;  /* for >32 bit machines */
    }
    mt.left = 1;
    mt.next = N;
  }

  /* generate N words at one time */
  function next_state(mt) {
    var p = 0, _p = mt.state;
    var j;

    mt.left = N;
    mt.next = 0;

    for (j=N-M+1; --j; p++)
      _p[p] = _p[p+(M)] ^ TWIST(_p[p+(0)], _p[p+(1)]);

    for (j=M; --j; p++)
      _p[p] = _p[p+(M-N)] ^ TWIST(_p[p+(0)], _p[p+(1)]);

    _p[p] = _p[p+(M-N)] ^ TWIST(_p[p+(0)], _p[0]);
  }

  /* generates a random number on [0,0xffffffff]-interval */
  function genrand_int32(mt) {
    /* mt must be initialized */
    var y;

    if (--mt.left <= 0) next_state(mt);
    y = mt.state[mt.next++];

    /* Tempering */
    y ^= (y >>> 11);
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= (y >>> 18);

    return y >>> 0;
  }

  function int_pair_to_real_exclusive(a, b) {
    a >>>= 5;
    b >>>= 6;
    return(a*67108864.0+b)*(1.0/9007199254740992.0);
  }

  // generates a random number on [0,1) with 53-bit resolution
  function genrand_real(mt) {
    /* mt must be initialized */
    var a = genrand_int32(mt), b = genrand_int32(mt);
    return int_pair_to_real_exclusive(a, b);
  }

  return { genrand_real: genrand_real, init: init };
})();
  return (function($base, $super) {
    var self = $klass($base, $super, 'Random');

    var $a;

    
    var MAX_INT = Number.MAX_SAFE_INTEGER || Math.pow(2, 53) - 1;
    $const_set(self, 'MERSENNE_TWISTER_GENERATOR', {
    new_seed: function() { return Math.round(Math.random() * MAX_INT); },
    reseed: function(seed) { return mersenne_twister.init(seed); },
    rand: function(mt) { return mersenne_twister.genrand_real(mt); }
  });
    return ($a = [$$$(self, 'MERSENNE_TWISTER_GENERATOR')], $send(self, 'generator=', $a), $a[$a.length - 1]);
  })('::', null);
};

Opal.modules["corelib/random"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, nil = Opal.nil, $$$ = Opal.$$$, $truthy = Opal.truthy, $klass = Opal.klass, $Kernel = Opal.Kernel, $defs = Opal.defs, $Opal = Opal.Opal, $def = Opal.def, $eqeqeq = Opal.eqeqeq, $send = Opal.send;

  Opal.add_stubs('require,attr_reader,to_int,raise,new_seed,coerce_to!,reseed,rand,seed,bytes,===,==,state,_verify_count,encode,join,new,chr,random_number,random_float,const_defined?,const_set');
  
  self.$require("corelib/random/formatter");
  (function($base, $super) {
    var self = $klass($base, $super, 'Random');

    
    
    self.$attr_reader("seed", "state");
    $defs(self, '$_verify_count', function $$_verify_count(count) {
      
      
      if (!$truthy(count)) count = 16;
      if (typeof count !== "number") count = (count).$to_int();
      if (count < 0) $Kernel.$raise($$$('ArgumentError'), "negative string size (or size too big)");
      count = Math.floor(count);
      return count;
    
    }, 1);
    
    $def(self, '$initialize', function $$initialize(seed) {
      var self = this;

      
      
      if (seed == null) seed = $$$('Random').$new_seed();;
      seed = $Opal['$coerce_to!'](seed, $$$('Integer'), "to_int");
      self.state = seed;
      return self.$reseed(seed);
    }, -1);
    
    $def(self, '$reseed', function $$reseed(seed) {
      var self = this;

      
      self.seed = seed;
      return self.$rng = Opal.$$rand.reseed(seed);;
    }, 1);
    $defs(self, '$new_seed', function $$new_seed() {
      
      return Opal.$$rand.new_seed();
    }, 0);
    $defs(self, '$rand', function $$rand(limit) {
      var self = this;

      
      ;
      return $$$(self, 'DEFAULT').$rand(limit);
    }, -1);
    $defs(self, '$srand', function $$srand(n) {
      var self = this, previous_seed = nil;

      
      
      if (n == null) n = $$$('Random').$new_seed();;
      n = $Opal['$coerce_to!'](n, $$$('Integer'), "to_int");
      previous_seed = $$$(self, 'DEFAULT').$seed();
      $$$(self, 'DEFAULT').$reseed(n);
      return previous_seed;
    }, -1);
    $defs(self, '$urandom', function $$urandom(size) {
      
      return $$$('SecureRandom').$bytes(size)
    }, 1);
    
    $def(self, '$==', function $Random_$eq_eq$1(other) {
      var self = this, $ret_or_1 = nil;

      
      if (!$eqeqeq($$$('Random'), other)) {
        return false
      };
      if ($truthy(($ret_or_1 = self.$seed()['$=='](other.$seed())))) {
        return self.$state()['$=='](other.$state())
      } else {
        return $ret_or_1
      };
    }, 1);
    
    $def(self, '$bytes', function $$bytes(length) {
      var self = this;

      
      length = $$$('Random').$_verify_count(length);
      return $send($$$('Array'), 'new', [length], function $$2(){var self = $$2.$$s == null ? this : $$2.$$s;

        return self.$rand(255).$chr()}, {$$arity: 0, $$s: self}).$join().$encode("ASCII-8BIT");
    }, 1);
    $defs(self, '$bytes', function $$bytes(length) {
      var self = this;

      return $$$(self, 'DEFAULT').$bytes(length)
    }, 1);
    
    $def(self, '$rand', function $$rand(limit) {
      var self = this;

      
      ;
      return self.$random_number(limit);
    }, -1);
    
    $def(self, '$random_float', function $$random_float() {
      var self = this;

      
      self.state++;
      return Opal.$$rand.rand(self.$rng);
    
    }, 0);
    $defs(self, '$random_float', function $$random_float() {
      var self = this;

      return $$$(self, 'DEFAULT').$random_float()
    }, 0);
    return $defs(self, '$generator=', function $Random_generator$eq$3(generator) {
      var self = this;

      
      Opal.$$rand = generator;
      if ($truthy(self['$const_defined?']("DEFAULT"))) {
        return $$$(self, 'DEFAULT').$reseed()
      } else {
        return self.$const_set("DEFAULT", self.$new(self.$new_seed()))
      };
    }, 1);
  })('::', null);
  return self.$require("corelib/random/mersenne_twister");
};

Opal.modules["corelib/unsupported"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $Kernel = Opal.Kernel, $klass = Opal.klass, $send = Opal.send, $module = Opal.module, $def = Opal.def, $return_val = Opal.return_val, $alias = Opal.alias, $defs = Opal.defs;

  Opal.add_stubs('raise,warn,each,define_method,%,public,private_method_defined?,private_class_method,instance_method,instance_methods,method_defined?,private_methods');
  
  
  var warnings = {};

  function handle_unsupported_feature(message) {
    switch (Opal.config.unsupported_features_severity) {
    case 'error':
      $Kernel.$raise($$$('NotImplementedError'), message)
      break;
    case 'warning':
      warn(message)
      break;
    default: // ignore
      // noop
    }
  }

  function warn(string) {
    if (warnings[string]) {
      return;
    }

    warnings[string] = true;
    self.$warn(string);
  }
;
  (function($base, $super) {
    var self = $klass($base, $super, 'String');

    
    
    var ERROR = "String#%s not supported. Mutable String methods are not supported in Opal.";
    return $send(["<<", "capitalize!", "chomp!", "chop!", "downcase!", "gsub!", "lstrip!", "next!", "reverse!", "slice!", "squeeze!", "strip!", "sub!", "succ!", "swapcase!", "tr!", "tr_s!", "upcase!", "prepend", "[]=", "clear", "encode!", "unicode_normalize!"], 'each', [], function $String$1(method_name){var self = $String$1.$$s == null ? this : $String$1.$$s;

      
      
      if (method_name == null) method_name = nil;;
      return $send(self, 'define_method', [method_name], function $$2($a){var $post_args, $rest_arg;

        
        
        $post_args = Opal.slice.call(arguments);
        
        $rest_arg = $post_args;;
        return $Kernel.$raise($$$('NotImplementedError'), (ERROR)['$%'](method_name));}, -1);}, {$$arity: 1, $$s: self});
  })('::', null);
  (function($base) {
    var self = $module($base, 'Kernel');

    
    
    var ERROR = "Object freezing is not supported by Opal";
    
    $def(self, '$freeze', function $$freeze() {
      var self = this;

      
      handle_unsupported_feature(ERROR);
      return self;
    }, 0);
    return $def(self, '$frozen?', function $Kernel_frozen$ques$3() {
      
      
      handle_unsupported_feature(ERROR);
      return false;
    }, 0);
  })('::');
  (function($base) {
    var self = $module($base, 'Kernel');

    
    
    var ERROR = "Object tainting is not supported by Opal";
    
    $def(self, '$taint', function $$taint() {
      var self = this;

      
      handle_unsupported_feature(ERROR);
      return self;
    }, 0);
    
    $def(self, '$untaint', function $$untaint() {
      var self = this;

      
      handle_unsupported_feature(ERROR);
      return self;
    }, 0);
    return $def(self, '$tainted?', function $Kernel_tainted$ques$4() {
      
      
      handle_unsupported_feature(ERROR);
      return false;
    }, 0);
  })('::');
  (function($base, $super) {
    var self = $klass($base, $super, 'Module');

    
    
    
    $def(self, '$public', function $Module_public$5($a) {
      var $post_args, methods, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      methods = $post_args;;
      
      if (methods.length === 0) {
        self.$$module_function = false;
        return nil;
      }
      return (methods.length === 1) ? methods[0] : methods;
    ;
    }, -1);
    
    $def(self, '$private_class_method', function $$private_class_method($a) {
      var $post_args, methods;

      
      
      $post_args = Opal.slice.call(arguments);
      
      methods = $post_args;;
      return (methods.length === 1) ? methods[0] : methods;;
    }, -1);
    
    $def(self, '$private_method_defined?', $return_val(false), 0);
    
    $def(self, '$private_constant', function $$private_constant($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return nil;
    }, -1);
    $alias(self, "nesting", "public");
    $alias(self, "private", "public");
    $alias(self, "protected", "public");
    $alias(self, "protected_method_defined?", "private_method_defined?");
    $alias(self, "public_class_method", "private_class_method");
    $alias(self, "public_instance_method", "instance_method");
    $alias(self, "public_instance_methods", "instance_methods");
    return $alias(self, "public_method_defined?", "method_defined?");
  })('::', null);
  (function($base) {
    var self = $module($base, 'Kernel');

    
    
    
    $def(self, '$private_methods', function $$private_methods($a) {
      var $post_args, methods;

      
      
      $post_args = Opal.slice.call(arguments);
      
      methods = $post_args;;
      return [];
    }, -1);
    return $alias(self, "private_instance_methods", "private_methods");
  })('::');
  (function($base, $parent_nesting) {
    var self = $module($base, 'Kernel');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    return $def(self, '$eval', function $Kernel_eval$6($a) {
      var $post_args, $rest_arg;

      
      
      $post_args = Opal.slice.call(arguments);
      
      $rest_arg = $post_args;;
      return $Kernel.$raise($$$('NotImplementedError'), "To use Kernel#eval, you must first require 'opal-parser'. " + ("See https://github.com/opal/opal/blob/" + ($$('RUBY_ENGINE_VERSION')) + "/docs/opal_parser.md for details."));
    }, -1)
  })('::', $nesting);
  $defs(self, '$public', function $public$7($a) {
    var $post_args, methods;

    
    
    $post_args = Opal.slice.call(arguments);
    
    methods = $post_args;;
    return (methods.length === 1) ? methods[0] : methods;;
  }, -1);
  return $defs(self, '$private', function $private$8($a) {
    var $post_args, methods;

    
    
    $post_args = Opal.slice.call(arguments);
    
    methods = $post_args;;
    return (methods.length === 1) ? methods[0] : methods;;
  }, -1);
};

Opal.modules["corelib/binding"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $klass = Opal.klass, $truthy = Opal.truthy, $def = Opal.def, $send = Opal.send, $to_a = Opal.to_a, $Kernel = Opal.Kernel, $return_ivar = Opal.return_ivar, $eqeq = Opal.eqeq, $module = Opal.module, $const_set = Opal.const_set;

  Opal.add_stubs('js_eval,call,raise,inspect,include?,==,receiver,eval,attr_reader,new');
  
  (function($base, $super) {
    var self = $klass($base, $super, 'Binding');

    var $proto = self.$$prototype;

    $proto.jseval = $proto.scope_variables = nil;
    
    
    $def(self, '$initialize', function $$initialize(jseval, scope_variables, receiver, source_location) {
      var $a, self = this;

      
      
      if (scope_variables == null) scope_variables = [];;
      ;
      
      if (source_location == null) source_location = nil;;
      $a = [jseval, scope_variables, receiver, source_location], (self.jseval = $a[0]), (self.scope_variables = $a[1]), (self.receiver = $a[2]), (self.source_location = $a[3]), $a;
      if ($truthy(typeof receiver !== undefined)) {
        return nil
      } else {
        return (receiver = self.$js_eval("self"))
      };
    }, -2);
    
    $def(self, '$js_eval', function $$js_eval($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if ($truthy(self.jseval)) {
        return $send(self.jseval, 'call', $to_a(args))
      } else {
        return $Kernel.$raise("Evaluation on a Proc#binding is not supported")
      };
    }, -1);
    
    $def(self, '$local_variable_get', function $$local_variable_get(symbol) {
      var self = this;

      try {
        return self.$js_eval(symbol)
      } catch ($err) {
        if (Opal.rescue($err, [$$$('Exception')])) {
          try {
            return $Kernel.$raise($$$('NameError'), "local variable `" + (symbol) + "' is not defined for " + (self.$inspect()))
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      }
    }, 1);
    
    $def(self, '$local_variable_set', function $$local_variable_set(symbol, value) {
      var self = this;

      
      Opal.Binding.tmp_value = value;
      self.$js_eval("" + (symbol) + " = Opal.Binding.tmp_value");
      delete Opal.Binding.tmp_value;
      return value;
    }, 2);
    
    $def(self, '$local_variables', $return_ivar("scope_variables"), 0);
    
    $def(self, '$local_variable_defined?', function $Binding_local_variable_defined$ques$1(value) {
      var self = this;

      return self.scope_variables['$include?'](value)
    }, 1);
    
    $def(self, '$eval', function $Binding_eval$2(str, file, line) {
      var self = this;

      
      
      if (file == null) file = nil;;
      
      if (line == null) line = nil;;
      if ($eqeq(str, "self")) {
        return self.$receiver()
      };
      return $Kernel.$eval(str, self, file, line);
    }, -2);
    return self.$attr_reader("receiver", "source_location");
  })('::', null);
  (function($base) {
    var self = $module($base, 'Kernel');

    
    return $def(self, '$binding', function $$binding() {
      
      return $Kernel.$raise("Opal doesn't support dynamic calls to binding")
    }, 0)
  })('::');
  return $const_set($nesting[0], 'TOPLEVEL_BINDING', $$$('Binding').$new(
    function(js) {
      return (new Function("self", "return " + js))(self);
    }
  , [], self, ["<main>", 0]));
};

Opal.modules["corelib/irb"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $truthy = Opal.truthy, $Kernel = Opal.Kernel, $defs = Opal.defs, $hash = Opal.hash, $gvars = Opal.gvars, $lambda = Opal.lambda, $send = Opal.send, $rb_plus = Opal.rb_plus, $const_set = Opal.const_set, $klass = Opal.klass, $def = Opal.def, $Opal = Opal.Opal, $range = Opal.range, $eqeq = Opal.eqeq;

  Opal.add_stubs('include?,raise,attr_accessor,singleton_class,output=,browser?,each,dup,write_proc=,proc,+,output,join,last,split,end_with?,call,write_proc,tty=,read_proc,read_proc=,freeze,new,string,ensure_loaded,prepare_console,loop,print,gets,puts,start_with?,[],==,silence,message,empty?,warnings,warn,full_message,eval_and_print,irb');
  
  (function($base, $parent_nesting) {
    var self = $module($base, 'Opal');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $parent_nesting) {
      var self = $module($base, 'IRB');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      $defs(self, '$ensure_loaded', function $$ensure_loaded(library) {
        var version = nil, url = nil;

        
        if ($truthy((Opal.loaded_features)['$include?'](library))) {
          return nil
        };
        version = ($truthy($$('RUBY_ENGINE_VERSION')['$include?']("dev")) ? ("master") : ($$('RUBY_ENGINE_VERSION')));
        url = "https://cdn.opalrb.com/opal/" + (version) + "/" + (library) + ".js";
        
        var libcode;

        if (typeof XMLHttpRequest !== 'undefined') { // Browser
          var r = new XMLHttpRequest();
          r.open("GET", url, false);
          r.send('');
          libcode = r.responseText;
        }
        else {
          $Kernel.$raise("You need to provision " + (library) + " yourself in this environment")
        }

        (new Function('Opal', libcode))(Opal);

        Opal.require(library);
      ;
        if ($truthy((Opal.loaded_features)['$include?'](library))) {
          return nil
        } else {
          return $Kernel.$raise("Could not load " + (library) + " for some reason")
        };
      }, 1);
      self.$singleton_class().$attr_accessor("output");
      $defs(self, '$prepare_console', function $$prepare_console() {
        var block = $$prepare_console.$$p || nil, $a, self = this, original = nil, original_read_proc = nil;
        if ($gvars.stdout == null) $gvars.stdout = nil;
        if ($gvars.stderr == null) $gvars.stderr = nil;
        if ($gvars.stdin == null) $gvars.stdin = nil;

        delete $$prepare_console.$$p;
        
        ;
        return (function() { try {
        
        self['$output=']("");
        original = $hash($gvars.stdout, $lambda(function $$1(i){
          
          
          if (i == null) i = nil;;
          return ($gvars.stdout = i);}, 1), $gvars.stderr, $lambda(function $$2(i){
          
          
          if (i == null) i = nil;;
          return ($gvars.stderr = i);}, 1));
        if ($truthy(self['$browser?']())) {
          
          $send(original, 'each', [], function $$3(pipe, pipe_setter){var self = $$3.$$s == null ? this : $$3.$$s, new_pipe = nil;

            
            
            if (pipe == null) pipe = nil;;
            
            if (pipe_setter == null) pipe_setter = nil;;
            new_pipe = pipe.$dup();
            new_pipe['$write_proc=']($send(self, 'proc', [], function $$4(str){var self = $$4.$$s == null ? this : $$4.$$s;

              
              
              if (str == null) str = nil;;
              self['$output=']($rb_plus(self.$output(), str));
              self['$output='](self.$output().$split("\n").$last(30).$join("\n"));
              if ($truthy(str['$end_with?']("\n"))) {
                self['$output=']($rb_plus(self.$output(), "\n"))
              };
              return pipe.$write_proc().$call(str);}, {$$arity: 1, $$s: self}));
            new_pipe['$tty='](false);
            return pipe_setter.$call(new_pipe);}, {$$arity: 2, $$s: self});
          original_read_proc = $gvars.stdin.$read_proc();
          $gvars.stdin['$read_proc='](function(s) { var p = prompt(self.$output()); if (p !== null) return p + "\n"; return nil; });
        };
        return Opal.yieldX(block, []);;
        } finally {
          ($send(original, 'each', [], function $$5(pipe, pipe_setter){
            
            
            if (pipe == null) pipe = nil;;
            
            if (pipe_setter == null) pipe_setter = nil;;
            return pipe_setter.$call(pipe);}, 2), ($a = [original_read_proc], $send($gvars.stdin, 'read_proc=', $a), $a[$a.length - 1]), ($a = [""], $send(self, 'output=', $a), $a[$a.length - 1]))
        }; })();
      }, 0);
      $defs(self, '$browser?', function $IRB_browser$ques$6() {
        
        return typeof(document) !== 'undefined' && typeof(prompt) !== 'undefined';
      }, 0);
      $const_set($nesting[0], 'LINEBREAKS', ["unexpected token $end", "unterminated string meets end of file"].$freeze());
      return (function($base, $super) {
        var self = $klass($base, $super, 'Silencer');

        var $proto = self.$$prototype;

        $proto.collector = $proto.stderr = nil;
        
        
        $def(self, '$initialize', function $$initialize() {
          var self = this;
          if ($gvars.stderr == null) $gvars.stderr = nil;

          return (self.stderr = $gvars.stderr)
        }, 0);
        
        $def(self, '$silence', function $$silence() {
          var $yield = $$silence.$$p || nil, self = this;

          delete $$silence.$$p;
          return (function() { try {
          
          self.collector = $$$('StringIO').$new();
          $gvars.stderr = self.collector;
          return Opal.yieldX($yield, []);;
          } finally {
            ($gvars.stderr = self.stderr)
          }; })()
        }, 0);
        return $def(self, '$warnings', function $$warnings() {
          var self = this;

          return self.collector.$string()
        }, 0);
      })($nesting[0], null);
    })($nesting[0], $nesting)
  })($nesting[0], $nesting);
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Binding');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    return $def(self, '$irb', function $$irb() {try {

      var self = this, silencer = nil;

      
      $$$($Opal, 'IRB').$ensure_loaded("opal-replutils");
      silencer = $$$($$$($Opal, 'IRB'), 'Silencer').$new();
      return (function(){var $brk = Opal.new_brk(); try {return $send($$$($Opal, 'IRB'), 'prepare_console', [], function $$7(){var self = $$7.$$s == null ? this : $$7.$$s;

        return (function(){var $brk = Opal.new_brk(); try {return $send(self, 'loop', [], function $$8(){var self = $$8.$$s == null ? this : $$8.$$s, line = nil, code = nil, mode = nil, js_code = nil, e = nil;

          
          self.$print(">> ");
          line = self.$gets();
          if (!$truthy(line)) {
            
            Opal.brk(nil, $brk)
          };
          code = "";
          if ($truthy($$$($Opal, 'IRB')['$browser?']())) {
            self.$puts(line)
          };
          if ($truthy(line['$start_with?']("ls "))) {
            
            code = line['$[]']($range(3, -1, false));
            mode = "ls";
          } else if ($eqeq(line, "ls\n")) {
            
            code = "self";
            mode = "ls";
          } else if ($truthy(line['$start_with?']("show "))) {
            
            code = line['$[]']($range(5, -1, false));
            mode = "show";
          } else {
            
            code = line;
            mode = "inspect";
          };
          js_code = nil;
          
          retry_1: do { try {
            $send(silencer, 'silence', [], function $$9(){
              return (js_code = Opal.compile(code, {irb: true}))}, 0)
          } catch ($err) {
            if (Opal.rescue($err, [$$('SyntaxError')])) {(e = $err)
              try {
                if ($truthy($$$($$$($Opal, 'IRB'), 'LINEBREAKS')['$include?'](e.$message()))) {
                  
                  self.$print(".. ");
                  line = self.$gets();
                  if (!$truthy(line)) {
                    Opal.ret(nil)
                  };
                  if ($truthy($$$($Opal, 'IRB')['$browser?']())) {
                    self.$puts(line)
                  };
                  code = $rb_plus(code, line);
                  continue retry_1;
                } else if ($truthy(silencer.$warnings()['$empty?']())) {
                  self.$warn(e.$full_message())
                } else {
                  self.$warn(silencer.$warnings())
                }
              } finally { Opal.pop_exception(); }
            } else { throw $err; }
          } break; } while(1);;
          if ($eqeq(mode, "show")) {
            
            self.$puts(js_code);
            Opal.ret(nil);
          };
          return self.$puts($$$('REPLUtils').$eval_and_print(js_code, mode, false, self));}, {$$arity: 0, $$s: self, $$brk: $brk})
        } catch (err) { if (err === $brk) { return err.$v } else { throw err } }})()}, {$$arity: 0, $$s: self, $$brk: $brk})
      } catch (err) { if (err === $brk) { return err.$v } else { throw err } }})();
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, 0)
  })('::', null, $nesting);
  
  // Run in WebTools console with: Opal.irb(c => eval(c))
  Opal.irb = function(fun) {
    $$$('Binding').$new(fun).$irb()
  }

  Opal.load_parser = function() {
    Opal.Opal.IRB.$ensure_loaded('opal-parser');
  }

  if (typeof Opal.eval === 'undefined') {
    Opal.eval = function(str) {
      Opal.load_parser();
      return Opal.eval(str);
    }
  }

  if (typeof Opal.compile === 'undefined') {
    Opal.compile = function(str, options) {
      Opal.load_parser();
      return Opal.compile(str, options);
    }
  }
;
};

Opal.modules["opal"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var nil = Opal.nil, $Object = Opal.Object;

  Opal.add_stubs('require,autoload');
  
  $Object.$require("opal/base");
  $Object.$require("opal/mini");
  $Object.$require("corelib/kernel/format");
  $Object.$require("corelib/string/encoding");
  $Object.$autoload("Math", "corelib/math");
  $Object.$require("corelib/complex/base");
  $Object.$autoload("Complex", "corelib/complex");
  $Object.$require("corelib/rational/base");
  $Object.$autoload("Rational", "corelib/rational");
  $Object.$require("corelib/time");
  $Object.$autoload("Struct", "corelib/struct");
  $Object.$autoload("Dir", "corelib/dir");
  $Object.$autoload("File", "corelib/file");
  $Object.$require("corelib/process/base");
  $Object.$autoload("Process", "corelib/process");
  $Object.$autoload("Random", "corelib/random");
  $Object.$require("corelib/unsupported");
  $Object.$require("corelib/binding");
  return $Object.$require("corelib/irb");
};

Opal.modules["opal/httpget/version"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $module = Opal.module, $const_set = Opal.const_set;

  return (function($base, $parent_nesting) {
    var self = $module($base, 'Opal');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $parent_nesting) {
      var self = $module($base, 'Httpget');

      var $nesting = [self].concat($parent_nesting);

      return $const_set($nesting[0], 'VERSION', "0.1.0")
    })($nesting[0], $nesting)
  })($nesting[0], $nesting)
};

/*! jQuery v3.6.0 | (c) OpenJS Foundation and other contributors | jquery.org/license */
!function(e,t){"use strict";"object"==typeof module&&"object"==typeof module.exports?module.exports=e.document?t(e,!0):function(e){if(!e.document)throw new Error("jQuery requires a window with a document");return t(e)}:t(e)}("undefined"!=typeof window?window:this,function(C,e){"use strict";var t=[],r=Object.getPrototypeOf,s=t.slice,g=t.flat?function(e){return t.flat.call(e)}:function(e){return t.concat.apply([],e)},u=t.push,i=t.indexOf,n={},o=n.toString,v=n.hasOwnProperty,a=v.toString,l=a.call(Object),y={},m=function(e){return"function"==typeof e&&"number"!=typeof e.nodeType&&"function"!=typeof e.item},x=function(e){return null!=e&&e===e.window},E=C.document,c={type:!0,src:!0,nonce:!0,noModule:!0};function b(e,t,n){var r,i,o=(n=n||E).createElement("script");if(o.text=e,t)for(r in c)(i=t[r]||t.getAttribute&&t.getAttribute(r))&&o.setAttribute(r,i);n.head.appendChild(o).parentNode.removeChild(o)}function w(e){return null==e?e+"":"object"==typeof e||"function"==typeof e?n[o.call(e)]||"object":typeof e}var f="3.6.0",S=function(e,t){return new S.fn.init(e,t)};function p(e){var t=!!e&&"length"in e&&e.length,n=w(e);return!m(e)&&!x(e)&&("array"===n||0===t||"number"==typeof t&&0<t&&t-1 in e)}S.fn=S.prototype={jquery:f,constructor:S,length:0,toArray:function(){return s.call(this)},get:function(e){return null==e?s.call(this):e<0?this[e+this.length]:this[e]},pushStack:function(e){var t=S.merge(this.constructor(),e);return t.prevObject=this,t},each:function(e){return S.each(this,e)},map:function(n){return this.pushStack(S.map(this,function(e,t){return n.call(e,t,e)}))},slice:function(){return this.pushStack(s.apply(this,arguments))},first:function(){return this.eq(0)},last:function(){return this.eq(-1)},even:function(){return this.pushStack(S.grep(this,function(e,t){return(t+1)%2}))},odd:function(){return this.pushStack(S.grep(this,function(e,t){return t%2}))},eq:function(e){var t=this.length,n=+e+(e<0?t:0);return this.pushStack(0<=n&&n<t?[this[n]]:[])},end:function(){return this.prevObject||this.constructor()},push:u,sort:t.sort,splice:t.splice},S.extend=S.fn.extend=function(){var e,t,n,r,i,o,a=arguments[0]||{},s=1,u=arguments.length,l=!1;for("boolean"==typeof a&&(l=a,a=arguments[s]||{},s++),"object"==typeof a||m(a)||(a={}),s===u&&(a=this,s--);s<u;s++)if(null!=(e=arguments[s]))for(t in e)r=e[t],"__proto__"!==t&&a!==r&&(l&&r&&(S.isPlainObject(r)||(i=Array.isArray(r)))?(n=a[t],o=i&&!Array.isArray(n)?[]:i||S.isPlainObject(n)?n:{},i=!1,a[t]=S.extend(l,o,r)):void 0!==r&&(a[t]=r));return a},S.extend({expando:"jQuery"+(f+Math.random()).replace(/\D/g,""),isReady:!0,error:function(e){throw new Error(e)},noop:function(){},isPlainObject:function(e){var t,n;return!(!e||"[object Object]"!==o.call(e))&&(!(t=r(e))||"function"==typeof(n=v.call(t,"constructor")&&t.constructor)&&a.call(n)===l)},isEmptyObject:function(e){var t;for(t in e)return!1;return!0},globalEval:function(e,t,n){b(e,{nonce:t&&t.nonce},n)},each:function(e,t){var n,r=0;if(p(e)){for(n=e.length;r<n;r++)if(!1===t.call(e[r],r,e[r]))break}else for(r in e)if(!1===t.call(e[r],r,e[r]))break;return e},makeArray:function(e,t){var n=t||[];return null!=e&&(p(Object(e))?S.merge(n,"string"==typeof e?[e]:e):u.call(n,e)),n},inArray:function(e,t,n){return null==t?-1:i.call(t,e,n)},merge:function(e,t){for(var n=+t.length,r=0,i=e.length;r<n;r++)e[i++]=t[r];return e.length=i,e},grep:function(e,t,n){for(var r=[],i=0,o=e.length,a=!n;i<o;i++)!t(e[i],i)!==a&&r.push(e[i]);return r},map:function(e,t,n){var r,i,o=0,a=[];if(p(e))for(r=e.length;o<r;o++)null!=(i=t(e[o],o,n))&&a.push(i);else for(o in e)null!=(i=t(e[o],o,n))&&a.push(i);return g(a)},guid:1,support:y}),"function"==typeof Symbol&&(S.fn[Symbol.iterator]=t[Symbol.iterator]),S.each("Boolean Number String Function Array Date RegExp Object Error Symbol".split(" "),function(e,t){n["[object "+t+"]"]=t.toLowerCase()});var d=function(n){var e,d,b,o,i,h,f,g,w,u,l,T,C,a,E,v,s,c,y,S="sizzle"+1*new Date,p=n.document,k=0,r=0,m=ue(),x=ue(),A=ue(),N=ue(),j=function(e,t){return e===t&&(l=!0),0},D={}.hasOwnProperty,t=[],q=t.pop,L=t.push,H=t.push,O=t.slice,P=function(e,t){for(var n=0,r=e.length;n<r;n++)if(e[n]===t)return n;return-1},R="checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",M="[\\x20\\t\\r\\n\\f]",I="(?:\\\\[\\da-fA-F]{1,6}"+M+"?|\\\\[^\\r\\n\\f]|[\\w-]|[^\0-\\x7f])+",W="\\["+M+"*("+I+")(?:"+M+"*([*^$|!~]?=)"+M+"*(?:'((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\"|("+I+"))|)"+M+"*\\]",F=":("+I+")(?:\\((('((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\")|((?:\\\\.|[^\\\\()[\\]]|"+W+")*)|.*)\\)|)",B=new RegExp(M+"+","g"),$=new RegExp("^"+M+"+|((?:^|[^\\\\])(?:\\\\.)*)"+M+"+$","g"),_=new RegExp("^"+M+"*,"+M+"*"),z=new RegExp("^"+M+"*([>+~]|"+M+")"+M+"*"),U=new RegExp(M+"|>"),X=new RegExp(F),V=new RegExp("^"+I+"$"),G={ID:new RegExp("^#("+I+")"),CLASS:new RegExp("^\\.("+I+")"),TAG:new RegExp("^("+I+"|[*])"),ATTR:new RegExp("^"+W),PSEUDO:new RegExp("^"+F),CHILD:new RegExp("^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\("+M+"*(even|odd|(([+-]|)(\\d*)n|)"+M+"*(?:([+-]|)"+M+"*(\\d+)|))"+M+"*\\)|)","i"),bool:new RegExp("^(?:"+R+")$","i"),needsContext:new RegExp("^"+M+"*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\("+M+"*((?:-\\d)?\\d*)"+M+"*\\)|)(?=[^-]|$)","i")},Y=/HTML$/i,Q=/^(?:input|select|textarea|button)$/i,J=/^h\d$/i,K=/^[^{]+\{\s*\[native \w/,Z=/^(?:#([\w-]+)|(\w+)|\.([\w-]+))$/,ee=/[+~]/,te=new RegExp("\\\\[\\da-fA-F]{1,6}"+M+"?|\\\\([^\\r\\n\\f])","g"),ne=function(e,t){var n="0x"+e.slice(1)-65536;return t||(n<0?String.fromCharCode(n+65536):String.fromCharCode(n>>10|55296,1023&n|56320))},re=/([\0-\x1f\x7f]|^-?\d)|^-$|[^\0-\x1f\x7f-\uFFFF\w-]/g,ie=function(e,t){return t?"\0"===e?"\ufffd":e.slice(0,-1)+"\\"+e.charCodeAt(e.length-1).toString(16)+" ":"\\"+e},oe=function(){T()},ae=be(function(e){return!0===e.disabled&&"fieldset"===e.nodeName.toLowerCase()},{dir:"parentNode",next:"legend"});try{H.apply(t=O.call(p.childNodes),p.childNodes),t[p.childNodes.length].nodeType}catch(e){H={apply:t.length?function(e,t){L.apply(e,O.call(t))}:function(e,t){var n=e.length,r=0;while(e[n++]=t[r++]);e.length=n-1}}}function se(t,e,n,r){var i,o,a,s,u,l,c,f=e&&e.ownerDocument,p=e?e.nodeType:9;if(n=n||[],"string"!=typeof t||!t||1!==p&&9!==p&&11!==p)return n;if(!r&&(T(e),e=e||C,E)){if(11!==p&&(u=Z.exec(t)))if(i=u[1]){if(9===p){if(!(a=e.getElementById(i)))return n;if(a.id===i)return n.push(a),n}else if(f&&(a=f.getElementById(i))&&y(e,a)&&a.id===i)return n.push(a),n}else{if(u[2])return H.apply(n,e.getElementsByTagName(t)),n;if((i=u[3])&&d.getElementsByClassName&&e.getElementsByClassName)return H.apply(n,e.getElementsByClassName(i)),n}if(d.qsa&&!N[t+" "]&&(!v||!v.test(t))&&(1!==p||"object"!==e.nodeName.toLowerCase())){if(c=t,f=e,1===p&&(U.test(t)||z.test(t))){(f=ee.test(t)&&ye(e.parentNode)||e)===e&&d.scope||((s=e.getAttribute("id"))?s=s.replace(re,ie):e.setAttribute("id",s=S)),o=(l=h(t)).length;while(o--)l[o]=(s?"#"+s:":scope")+" "+xe(l[o]);c=l.join(",")}try{return H.apply(n,f.querySelectorAll(c)),n}catch(e){N(t,!0)}finally{s===S&&e.removeAttribute("id")}}}return g(t.replace($,"$1"),e,n,r)}function ue(){var r=[];return function e(t,n){return r.push(t+" ")>b.cacheLength&&delete e[r.shift()],e[t+" "]=n}}function le(e){return e[S]=!0,e}function ce(e){var t=C.createElement("fieldset");try{return!!e(t)}catch(e){return!1}finally{t.parentNode&&t.parentNode.removeChild(t),t=null}}function fe(e,t){var n=e.split("|"),r=n.length;while(r--)b.attrHandle[n[r]]=t}function pe(e,t){var n=t&&e,r=n&&1===e.nodeType&&1===t.nodeType&&e.sourceIndex-t.sourceIndex;if(r)return r;if(n)while(n=n.nextSibling)if(n===t)return-1;return e?1:-1}function de(t){return function(e){return"input"===e.nodeName.toLowerCase()&&e.type===t}}function he(n){return function(e){var t=e.nodeName.toLowerCase();return("input"===t||"button"===t)&&e.type===n}}function ge(t){return function(e){return"form"in e?e.parentNode&&!1===e.disabled?"label"in e?"label"in e.parentNode?e.parentNode.disabled===t:e.disabled===t:e.isDisabled===t||e.isDisabled!==!t&&ae(e)===t:e.disabled===t:"label"in e&&e.disabled===t}}function ve(a){return le(function(o){return o=+o,le(function(e,t){var n,r=a([],e.length,o),i=r.length;while(i--)e[n=r[i]]&&(e[n]=!(t[n]=e[n]))})})}function ye(e){return e&&"undefined"!=typeof e.getElementsByTagName&&e}for(e in d=se.support={},i=se.isXML=function(e){var t=e&&e.namespaceURI,n=e&&(e.ownerDocument||e).documentElement;return!Y.test(t||n&&n.nodeName||"HTML")},T=se.setDocument=function(e){var t,n,r=e?e.ownerDocument||e:p;return r!=C&&9===r.nodeType&&r.documentElement&&(a=(C=r).documentElement,E=!i(C),p!=C&&(n=C.defaultView)&&n.top!==n&&(n.addEventListener?n.addEventListener("unload",oe,!1):n.attachEvent&&n.attachEvent("onunload",oe)),d.scope=ce(function(e){return a.appendChild(e).appendChild(C.createElement("div")),"undefined"!=typeof e.querySelectorAll&&!e.querySelectorAll(":scope fieldset div").length}),d.attributes=ce(function(e){return e.className="i",!e.getAttribute("className")}),d.getElementsByTagName=ce(function(e){return e.appendChild(C.createComment("")),!e.getElementsByTagName("*").length}),d.getElementsByClassName=K.test(C.getElementsByClassName),d.getById=ce(function(e){return a.appendChild(e).id=S,!C.getElementsByName||!C.getElementsByName(S).length}),d.getById?(b.filter.ID=function(e){var t=e.replace(te,ne);return function(e){return e.getAttribute("id")===t}},b.find.ID=function(e,t){if("undefined"!=typeof t.getElementById&&E){var n=t.getElementById(e);return n?[n]:[]}}):(b.filter.ID=function(e){var n=e.replace(te,ne);return function(e){var t="undefined"!=typeof e.getAttributeNode&&e.getAttributeNode("id");return t&&t.value===n}},b.find.ID=function(e,t){if("undefined"!=typeof t.getElementById&&E){var n,r,i,o=t.getElementById(e);if(o){if((n=o.getAttributeNode("id"))&&n.value===e)return[o];i=t.getElementsByName(e),r=0;while(o=i[r++])if((n=o.getAttributeNode("id"))&&n.value===e)return[o]}return[]}}),b.find.TAG=d.getElementsByTagName?function(e,t){return"undefined"!=typeof t.getElementsByTagName?t.getElementsByTagName(e):d.qsa?t.querySelectorAll(e):void 0}:function(e,t){var n,r=[],i=0,o=t.getElementsByTagName(e);if("*"===e){while(n=o[i++])1===n.nodeType&&r.push(n);return r}return o},b.find.CLASS=d.getElementsByClassName&&function(e,t){if("undefined"!=typeof t.getElementsByClassName&&E)return t.getElementsByClassName(e)},s=[],v=[],(d.qsa=K.test(C.querySelectorAll))&&(ce(function(e){var t;a.appendChild(e).innerHTML="<a id='"+S+"'></a><select id='"+S+"-\r\\' msallowcapture=''><option selected=''></option></select>",e.querySelectorAll("[msallowcapture^='']").length&&v.push("[*^$]="+M+"*(?:''|\"\")"),e.querySelectorAll("[selected]").length||v.push("\\["+M+"*(?:value|"+R+")"),e.querySelectorAll("[id~="+S+"-]").length||v.push("~="),(t=C.createElement("input")).setAttribute("name",""),e.appendChild(t),e.querySelectorAll("[name='']").length||v.push("\\["+M+"*name"+M+"*="+M+"*(?:''|\"\")"),e.querySelectorAll(":checked").length||v.push(":checked"),e.querySelectorAll("a#"+S+"+*").length||v.push(".#.+[+~]"),e.querySelectorAll("\\\f"),v.push("[\\r\\n\\f]")}),ce(function(e){e.innerHTML="<a href='' disabled='disabled'></a><select disabled='disabled'><option/></select>";var t=C.createElement("input");t.setAttribute("type","hidden"),e.appendChild(t).setAttribute("name","D"),e.querySelectorAll("[name=d]").length&&v.push("name"+M+"*[*^$|!~]?="),2!==e.querySelectorAll(":enabled").length&&v.push(":enabled",":disabled"),a.appendChild(e).disabled=!0,2!==e.querySelectorAll(":disabled").length&&v.push(":enabled",":disabled"),e.querySelectorAll("*,:x"),v.push(",.*:")})),(d.matchesSelector=K.test(c=a.matches||a.webkitMatchesSelector||a.mozMatchesSelector||a.oMatchesSelector||a.msMatchesSelector))&&ce(function(e){d.disconnectedMatch=c.call(e,"*"),c.call(e,"[s!='']:x"),s.push("!=",F)}),v=v.length&&new RegExp(v.join("|")),s=s.length&&new RegExp(s.join("|")),t=K.test(a.compareDocumentPosition),y=t||K.test(a.contains)?function(e,t){var n=9===e.nodeType?e.documentElement:e,r=t&&t.parentNode;return e===r||!(!r||1!==r.nodeType||!(n.contains?n.contains(r):e.compareDocumentPosition&&16&e.compareDocumentPosition(r)))}:function(e,t){if(t)while(t=t.parentNode)if(t===e)return!0;return!1},j=t?function(e,t){if(e===t)return l=!0,0;var n=!e.compareDocumentPosition-!t.compareDocumentPosition;return n||(1&(n=(e.ownerDocument||e)==(t.ownerDocument||t)?e.compareDocumentPosition(t):1)||!d.sortDetached&&t.compareDocumentPosition(e)===n?e==C||e.ownerDocument==p&&y(p,e)?-1:t==C||t.ownerDocument==p&&y(p,t)?1:u?P(u,e)-P(u,t):0:4&n?-1:1)}:function(e,t){if(e===t)return l=!0,0;var n,r=0,i=e.parentNode,o=t.parentNode,a=[e],s=[t];if(!i||!o)return e==C?-1:t==C?1:i?-1:o?1:u?P(u,e)-P(u,t):0;if(i===o)return pe(e,t);n=e;while(n=n.parentNode)a.unshift(n);n=t;while(n=n.parentNode)s.unshift(n);while(a[r]===s[r])r++;return r?pe(a[r],s[r]):a[r]==p?-1:s[r]==p?1:0}),C},se.matches=function(e,t){return se(e,null,null,t)},se.matchesSelector=function(e,t){if(T(e),d.matchesSelector&&E&&!N[t+" "]&&(!s||!s.test(t))&&(!v||!v.test(t)))try{var n=c.call(e,t);if(n||d.disconnectedMatch||e.document&&11!==e.document.nodeType)return n}catch(e){N(t,!0)}return 0<se(t,C,null,[e]).length},se.contains=function(e,t){return(e.ownerDocument||e)!=C&&T(e),y(e,t)},se.attr=function(e,t){(e.ownerDocument||e)!=C&&T(e);var n=b.attrHandle[t.toLowerCase()],r=n&&D.call(b.attrHandle,t.toLowerCase())?n(e,t,!E):void 0;return void 0!==r?r:d.attributes||!E?e.getAttribute(t):(r=e.getAttributeNode(t))&&r.specified?r.value:null},se.escape=function(e){return(e+"").replace(re,ie)},se.error=function(e){throw new Error("Syntax error, unrecognized expression: "+e)},se.uniqueSort=function(e){var t,n=[],r=0,i=0;if(l=!d.detectDuplicates,u=!d.sortStable&&e.slice(0),e.sort(j),l){while(t=e[i++])t===e[i]&&(r=n.push(i));while(r--)e.splice(n[r],1)}return u=null,e},o=se.getText=function(e){var t,n="",r=0,i=e.nodeType;if(i){if(1===i||9===i||11===i){if("string"==typeof e.textContent)return e.textContent;for(e=e.firstChild;e;e=e.nextSibling)n+=o(e)}else if(3===i||4===i)return e.nodeValue}else while(t=e[r++])n+=o(t);return n},(b=se.selectors={cacheLength:50,createPseudo:le,match:G,attrHandle:{},find:{},relative:{">":{dir:"parentNode",first:!0}," ":{dir:"parentNode"},"+":{dir:"previousSibling",first:!0},"~":{dir:"previousSibling"}},preFilter:{ATTR:function(e){return e[1]=e[1].replace(te,ne),e[3]=(e[3]||e[4]||e[5]||"").replace(te,ne),"~="===e[2]&&(e[3]=" "+e[3]+" "),e.slice(0,4)},CHILD:function(e){return e[1]=e[1].toLowerCase(),"nth"===e[1].slice(0,3)?(e[3]||se.error(e[0]),e[4]=+(e[4]?e[5]+(e[6]||1):2*("even"===e[3]||"odd"===e[3])),e[5]=+(e[7]+e[8]||"odd"===e[3])):e[3]&&se.error(e[0]),e},PSEUDO:function(e){var t,n=!e[6]&&e[2];return G.CHILD.test(e[0])?null:(e[3]?e[2]=e[4]||e[5]||"":n&&X.test(n)&&(t=h(n,!0))&&(t=n.indexOf(")",n.length-t)-n.length)&&(e[0]=e[0].slice(0,t),e[2]=n.slice(0,t)),e.slice(0,3))}},filter:{TAG:function(e){var t=e.replace(te,ne).toLowerCase();return"*"===e?function(){return!0}:function(e){return e.nodeName&&e.nodeName.toLowerCase()===t}},CLASS:function(e){var t=m[e+" "];return t||(t=new RegExp("(^|"+M+")"+e+"("+M+"|$)"))&&m(e,function(e){return t.test("string"==typeof e.className&&e.className||"undefined"!=typeof e.getAttribute&&e.getAttribute("class")||"")})},ATTR:function(n,r,i){return function(e){var t=se.attr(e,n);return null==t?"!="===r:!r||(t+="","="===r?t===i:"!="===r?t!==i:"^="===r?i&&0===t.indexOf(i):"*="===r?i&&-1<t.indexOf(i):"$="===r?i&&t.slice(-i.length)===i:"~="===r?-1<(" "+t.replace(B," ")+" ").indexOf(i):"|="===r&&(t===i||t.slice(0,i.length+1)===i+"-"))}},CHILD:function(h,e,t,g,v){var y="nth"!==h.slice(0,3),m="last"!==h.slice(-4),x="of-type"===e;return 1===g&&0===v?function(e){return!!e.parentNode}:function(e,t,n){var r,i,o,a,s,u,l=y!==m?"nextSibling":"previousSibling",c=e.parentNode,f=x&&e.nodeName.toLowerCase(),p=!n&&!x,d=!1;if(c){if(y){while(l){a=e;while(a=a[l])if(x?a.nodeName.toLowerCase()===f:1===a.nodeType)return!1;u=l="only"===h&&!u&&"nextSibling"}return!0}if(u=[m?c.firstChild:c.lastChild],m&&p){d=(s=(r=(i=(o=(a=c)[S]||(a[S]={}))[a.uniqueID]||(o[a.uniqueID]={}))[h]||[])[0]===k&&r[1])&&r[2],a=s&&c.childNodes[s];while(a=++s&&a&&a[l]||(d=s=0)||u.pop())if(1===a.nodeType&&++d&&a===e){i[h]=[k,s,d];break}}else if(p&&(d=s=(r=(i=(o=(a=e)[S]||(a[S]={}))[a.uniqueID]||(o[a.uniqueID]={}))[h]||[])[0]===k&&r[1]),!1===d)while(a=++s&&a&&a[l]||(d=s=0)||u.pop())if((x?a.nodeName.toLowerCase()===f:1===a.nodeType)&&++d&&(p&&((i=(o=a[S]||(a[S]={}))[a.uniqueID]||(o[a.uniqueID]={}))[h]=[k,d]),a===e))break;return(d-=v)===g||d%g==0&&0<=d/g}}},PSEUDO:function(e,o){var t,a=b.pseudos[e]||b.setFilters[e.toLowerCase()]||se.error("unsupported pseudo: "+e);return a[S]?a(o):1<a.length?(t=[e,e,"",o],b.setFilters.hasOwnProperty(e.toLowerCase())?le(function(e,t){var n,r=a(e,o),i=r.length;while(i--)e[n=P(e,r[i])]=!(t[n]=r[i])}):function(e){return a(e,0,t)}):a}},pseudos:{not:le(function(e){var r=[],i=[],s=f(e.replace($,"$1"));return s[S]?le(function(e,t,n,r){var i,o=s(e,null,r,[]),a=e.length;while(a--)(i=o[a])&&(e[a]=!(t[a]=i))}):function(e,t,n){return r[0]=e,s(r,null,n,i),r[0]=null,!i.pop()}}),has:le(function(t){return function(e){return 0<se(t,e).length}}),contains:le(function(t){return t=t.replace(te,ne),function(e){return-1<(e.textContent||o(e)).indexOf(t)}}),lang:le(function(n){return V.test(n||"")||se.error("unsupported lang: "+n),n=n.replace(te,ne).toLowerCase(),function(e){var t;do{if(t=E?e.lang:e.getAttribute("xml:lang")||e.getAttribute("lang"))return(t=t.toLowerCase())===n||0===t.indexOf(n+"-")}while((e=e.parentNode)&&1===e.nodeType);return!1}}),target:function(e){var t=n.location&&n.location.hash;return t&&t.slice(1)===e.id},root:function(e){return e===a},focus:function(e){return e===C.activeElement&&(!C.hasFocus||C.hasFocus())&&!!(e.type||e.href||~e.tabIndex)},enabled:ge(!1),disabled:ge(!0),checked:function(e){var t=e.nodeName.toLowerCase();return"input"===t&&!!e.checked||"option"===t&&!!e.selected},selected:function(e){return e.parentNode&&e.parentNode.selectedIndex,!0===e.selected},empty:function(e){for(e=e.firstChild;e;e=e.nextSibling)if(e.nodeType<6)return!1;return!0},parent:function(e){return!b.pseudos.empty(e)},header:function(e){return J.test(e.nodeName)},input:function(e){return Q.test(e.nodeName)},button:function(e){var t=e.nodeName.toLowerCase();return"input"===t&&"button"===e.type||"button"===t},text:function(e){var t;return"input"===e.nodeName.toLowerCase()&&"text"===e.type&&(null==(t=e.getAttribute("type"))||"text"===t.toLowerCase())},first:ve(function(){return[0]}),last:ve(function(e,t){return[t-1]}),eq:ve(function(e,t,n){return[n<0?n+t:n]}),even:ve(function(e,t){for(var n=0;n<t;n+=2)e.push(n);return e}),odd:ve(function(e,t){for(var n=1;n<t;n+=2)e.push(n);return e}),lt:ve(function(e,t,n){for(var r=n<0?n+t:t<n?t:n;0<=--r;)e.push(r);return e}),gt:ve(function(e,t,n){for(var r=n<0?n+t:n;++r<t;)e.push(r);return e})}}).pseudos.nth=b.pseudos.eq,{radio:!0,checkbox:!0,file:!0,password:!0,image:!0})b.pseudos[e]=de(e);for(e in{submit:!0,reset:!0})b.pseudos[e]=he(e);function me(){}function xe(e){for(var t=0,n=e.length,r="";t<n;t++)r+=e[t].value;return r}function be(s,e,t){var u=e.dir,l=e.next,c=l||u,f=t&&"parentNode"===c,p=r++;return e.first?function(e,t,n){while(e=e[u])if(1===e.nodeType||f)return s(e,t,n);return!1}:function(e,t,n){var r,i,o,a=[k,p];if(n){while(e=e[u])if((1===e.nodeType||f)&&s(e,t,n))return!0}else while(e=e[u])if(1===e.nodeType||f)if(i=(o=e[S]||(e[S]={}))[e.uniqueID]||(o[e.uniqueID]={}),l&&l===e.nodeName.toLowerCase())e=e[u]||e;else{if((r=i[c])&&r[0]===k&&r[1]===p)return a[2]=r[2];if((i[c]=a)[2]=s(e,t,n))return!0}return!1}}function we(i){return 1<i.length?function(e,t,n){var r=i.length;while(r--)if(!i[r](e,t,n))return!1;return!0}:i[0]}function Te(e,t,n,r,i){for(var o,a=[],s=0,u=e.length,l=null!=t;s<u;s++)(o=e[s])&&(n&&!n(o,r,i)||(a.push(o),l&&t.push(s)));return a}function Ce(d,h,g,v,y,e){return v&&!v[S]&&(v=Ce(v)),y&&!y[S]&&(y=Ce(y,e)),le(function(e,t,n,r){var i,o,a,s=[],u=[],l=t.length,c=e||function(e,t,n){for(var r=0,i=t.length;r<i;r++)se(e,t[r],n);return n}(h||"*",n.nodeType?[n]:n,[]),f=!d||!e&&h?c:Te(c,s,d,n,r),p=g?y||(e?d:l||v)?[]:t:f;if(g&&g(f,p,n,r),v){i=Te(p,u),v(i,[],n,r),o=i.length;while(o--)(a=i[o])&&(p[u[o]]=!(f[u[o]]=a))}if(e){if(y||d){if(y){i=[],o=p.length;while(o--)(a=p[o])&&i.push(f[o]=a);y(null,p=[],i,r)}o=p.length;while(o--)(a=p[o])&&-1<(i=y?P(e,a):s[o])&&(e[i]=!(t[i]=a))}}else p=Te(p===t?p.splice(l,p.length):p),y?y(null,t,p,r):H.apply(t,p)})}function Ee(e){for(var i,t,n,r=e.length,o=b.relative[e[0].type],a=o||b.relative[" "],s=o?1:0,u=be(function(e){return e===i},a,!0),l=be(function(e){return-1<P(i,e)},a,!0),c=[function(e,t,n){var r=!o&&(n||t!==w)||((i=t).nodeType?u(e,t,n):l(e,t,n));return i=null,r}];s<r;s++)if(t=b.relative[e[s].type])c=[be(we(c),t)];else{if((t=b.filter[e[s].type].apply(null,e[s].matches))[S]){for(n=++s;n<r;n++)if(b.relative[e[n].type])break;return Ce(1<s&&we(c),1<s&&xe(e.slice(0,s-1).concat({value:" "===e[s-2].type?"*":""})).replace($,"$1"),t,s<n&&Ee(e.slice(s,n)),n<r&&Ee(e=e.slice(n)),n<r&&xe(e))}c.push(t)}return we(c)}return me.prototype=b.filters=b.pseudos,b.setFilters=new me,h=se.tokenize=function(e,t){var n,r,i,o,a,s,u,l=x[e+" "];if(l)return t?0:l.slice(0);a=e,s=[],u=b.preFilter;while(a){for(o in n&&!(r=_.exec(a))||(r&&(a=a.slice(r[0].length)||a),s.push(i=[])),n=!1,(r=z.exec(a))&&(n=r.shift(),i.push({value:n,type:r[0].replace($," ")}),a=a.slice(n.length)),b.filter)!(r=G[o].exec(a))||u[o]&&!(r=u[o](r))||(n=r.shift(),i.push({value:n,type:o,matches:r}),a=a.slice(n.length));if(!n)break}return t?a.length:a?se.error(e):x(e,s).slice(0)},f=se.compile=function(e,t){var n,v,y,m,x,r,i=[],o=[],a=A[e+" "];if(!a){t||(t=h(e)),n=t.length;while(n--)(a=Ee(t[n]))[S]?i.push(a):o.push(a);(a=A(e,(v=o,m=0<(y=i).length,x=0<v.length,r=function(e,t,n,r,i){var o,a,s,u=0,l="0",c=e&&[],f=[],p=w,d=e||x&&b.find.TAG("*",i),h=k+=null==p?1:Math.random()||.1,g=d.length;for(i&&(w=t==C||t||i);l!==g&&null!=(o=d[l]);l++){if(x&&o){a=0,t||o.ownerDocument==C||(T(o),n=!E);while(s=v[a++])if(s(o,t||C,n)){r.push(o);break}i&&(k=h)}m&&((o=!s&&o)&&u--,e&&c.push(o))}if(u+=l,m&&l!==u){a=0;while(s=y[a++])s(c,f,t,n);if(e){if(0<u)while(l--)c[l]||f[l]||(f[l]=q.call(r));f=Te(f)}H.apply(r,f),i&&!e&&0<f.length&&1<u+y.length&&se.uniqueSort(r)}return i&&(k=h,w=p),c},m?le(r):r))).selector=e}return a},g=se.select=function(e,t,n,r){var i,o,a,s,u,l="function"==typeof e&&e,c=!r&&h(e=l.selector||e);if(n=n||[],1===c.length){if(2<(o=c[0]=c[0].slice(0)).length&&"ID"===(a=o[0]).type&&9===t.nodeType&&E&&b.relative[o[1].type]){if(!(t=(b.find.ID(a.matches[0].replace(te,ne),t)||[])[0]))return n;l&&(t=t.parentNode),e=e.slice(o.shift().value.length)}i=G.needsContext.test(e)?0:o.length;while(i--){if(a=o[i],b.relative[s=a.type])break;if((u=b.find[s])&&(r=u(a.matches[0].replace(te,ne),ee.test(o[0].type)&&ye(t.parentNode)||t))){if(o.splice(i,1),!(e=r.length&&xe(o)))return H.apply(n,r),n;break}}}return(l||f(e,c))(r,t,!E,n,!t||ee.test(e)&&ye(t.parentNode)||t),n},d.sortStable=S.split("").sort(j).join("")===S,d.detectDuplicates=!!l,T(),d.sortDetached=ce(function(e){return 1&e.compareDocumentPosition(C.createElement("fieldset"))}),ce(function(e){return e.innerHTML="<a href='#'></a>","#"===e.firstChild.getAttribute("href")})||fe("type|href|height|width",function(e,t,n){if(!n)return e.getAttribute(t,"type"===t.toLowerCase()?1:2)}),d.attributes&&ce(function(e){return e.innerHTML="<input/>",e.firstChild.setAttribute("value",""),""===e.firstChild.getAttribute("value")})||fe("value",function(e,t,n){if(!n&&"input"===e.nodeName.toLowerCase())return e.defaultValue}),ce(function(e){return null==e.getAttribute("disabled")})||fe(R,function(e,t,n){var r;if(!n)return!0===e[t]?t.toLowerCase():(r=e.getAttributeNode(t))&&r.specified?r.value:null}),se}(C);S.find=d,S.expr=d.selectors,S.expr[":"]=S.expr.pseudos,S.uniqueSort=S.unique=d.uniqueSort,S.text=d.getText,S.isXMLDoc=d.isXML,S.contains=d.contains,S.escapeSelector=d.escape;var h=function(e,t,n){var r=[],i=void 0!==n;while((e=e[t])&&9!==e.nodeType)if(1===e.nodeType){if(i&&S(e).is(n))break;r.push(e)}return r},T=function(e,t){for(var n=[];e;e=e.nextSibling)1===e.nodeType&&e!==t&&n.push(e);return n},k=S.expr.match.needsContext;function A(e,t){return e.nodeName&&e.nodeName.toLowerCase()===t.toLowerCase()}var N=/^<([a-z][^\/\0>:\x20\t\r\n\f]*)[\x20\t\r\n\f]*\/?>(?:<\/\1>|)$/i;function j(e,n,r){return m(n)?S.grep(e,function(e,t){return!!n.call(e,t,e)!==r}):n.nodeType?S.grep(e,function(e){return e===n!==r}):"string"!=typeof n?S.grep(e,function(e){return-1<i.call(n,e)!==r}):S.filter(n,e,r)}S.filter=function(e,t,n){var r=t[0];return n&&(e=":not("+e+")"),1===t.length&&1===r.nodeType?S.find.matchesSelector(r,e)?[r]:[]:S.find.matches(e,S.grep(t,function(e){return 1===e.nodeType}))},S.fn.extend({find:function(e){var t,n,r=this.length,i=this;if("string"!=typeof e)return this.pushStack(S(e).filter(function(){for(t=0;t<r;t++)if(S.contains(i[t],this))return!0}));for(n=this.pushStack([]),t=0;t<r;t++)S.find(e,i[t],n);return 1<r?S.uniqueSort(n):n},filter:function(e){return this.pushStack(j(this,e||[],!1))},not:function(e){return this.pushStack(j(this,e||[],!0))},is:function(e){return!!j(this,"string"==typeof e&&k.test(e)?S(e):e||[],!1).length}});var D,q=/^(?:\s*(<[\w\W]+>)[^>]*|#([\w-]+))$/;(S.fn.init=function(e,t,n){var r,i;if(!e)return this;if(n=n||D,"string"==typeof e){if(!(r="<"===e[0]&&">"===e[e.length-1]&&3<=e.length?[null,e,null]:q.exec(e))||!r[1]&&t)return!t||t.jquery?(t||n).find(e):this.constructor(t).find(e);if(r[1]){if(t=t instanceof S?t[0]:t,S.merge(this,S.parseHTML(r[1],t&&t.nodeType?t.ownerDocument||t:E,!0)),N.test(r[1])&&S.isPlainObject(t))for(r in t)m(this[r])?this[r](t[r]):this.attr(r,t[r]);return this}return(i=E.getElementById(r[2]))&&(this[0]=i,this.length=1),this}return e.nodeType?(this[0]=e,this.length=1,this):m(e)?void 0!==n.ready?n.ready(e):e(S):S.makeArray(e,this)}).prototype=S.fn,D=S(E);var L=/^(?:parents|prev(?:Until|All))/,H={children:!0,contents:!0,next:!0,prev:!0};function O(e,t){while((e=e[t])&&1!==e.nodeType);return e}S.fn.extend({has:function(e){var t=S(e,this),n=t.length;return this.filter(function(){for(var e=0;e<n;e++)if(S.contains(this,t[e]))return!0})},closest:function(e,t){var n,r=0,i=this.length,o=[],a="string"!=typeof e&&S(e);if(!k.test(e))for(;r<i;r++)for(n=this[r];n&&n!==t;n=n.parentNode)if(n.nodeType<11&&(a?-1<a.index(n):1===n.nodeType&&S.find.matchesSelector(n,e))){o.push(n);break}return this.pushStack(1<o.length?S.uniqueSort(o):o)},index:function(e){return e?"string"==typeof e?i.call(S(e),this[0]):i.call(this,e.jquery?e[0]:e):this[0]&&this[0].parentNode?this.first().prevAll().length:-1},add:function(e,t){return this.pushStack(S.uniqueSort(S.merge(this.get(),S(e,t))))},addBack:function(e){return this.add(null==e?this.prevObject:this.prevObject.filter(e))}}),S.each({parent:function(e){var t=e.parentNode;return t&&11!==t.nodeType?t:null},parents:function(e){return h(e,"parentNode")},parentsUntil:function(e,t,n){return h(e,"parentNode",n)},next:function(e){return O(e,"nextSibling")},prev:function(e){return O(e,"previousSibling")},nextAll:function(e){return h(e,"nextSibling")},prevAll:function(e){return h(e,"previousSibling")},nextUntil:function(e,t,n){return h(e,"nextSibling",n)},prevUntil:function(e,t,n){return h(e,"previousSibling",n)},siblings:function(e){return T((e.parentNode||{}).firstChild,e)},children:function(e){return T(e.firstChild)},contents:function(e){return null!=e.contentDocument&&r(e.contentDocument)?e.contentDocument:(A(e,"template")&&(e=e.content||e),S.merge([],e.childNodes))}},function(r,i){S.fn[r]=function(e,t){var n=S.map(this,i,e);return"Until"!==r.slice(-5)&&(t=e),t&&"string"==typeof t&&(n=S.filter(t,n)),1<this.length&&(H[r]||S.uniqueSort(n),L.test(r)&&n.reverse()),this.pushStack(n)}});var P=/[^\x20\t\r\n\f]+/g;function R(e){return e}function M(e){throw e}function I(e,t,n,r){var i;try{e&&m(i=e.promise)?i.call(e).done(t).fail(n):e&&m(i=e.then)?i.call(e,t,n):t.apply(void 0,[e].slice(r))}catch(e){n.apply(void 0,[e])}}S.Callbacks=function(r){var e,n;r="string"==typeof r?(e=r,n={},S.each(e.match(P)||[],function(e,t){n[t]=!0}),n):S.extend({},r);var i,t,o,a,s=[],u=[],l=-1,c=function(){for(a=a||r.once,o=i=!0;u.length;l=-1){t=u.shift();while(++l<s.length)!1===s[l].apply(t[0],t[1])&&r.stopOnFalse&&(l=s.length,t=!1)}r.memory||(t=!1),i=!1,a&&(s=t?[]:"")},f={add:function(){return s&&(t&&!i&&(l=s.length-1,u.push(t)),function n(e){S.each(e,function(e,t){m(t)?r.unique&&f.has(t)||s.push(t):t&&t.length&&"string"!==w(t)&&n(t)})}(arguments),t&&!i&&c()),this},remove:function(){return S.each(arguments,function(e,t){var n;while(-1<(n=S.inArray(t,s,n)))s.splice(n,1),n<=l&&l--}),this},has:function(e){return e?-1<S.inArray(e,s):0<s.length},empty:function(){return s&&(s=[]),this},disable:function(){return a=u=[],s=t="",this},disabled:function(){return!s},lock:function(){return a=u=[],t||i||(s=t=""),this},locked:function(){return!!a},fireWith:function(e,t){return a||(t=[e,(t=t||[]).slice?t.slice():t],u.push(t),i||c()),this},fire:function(){return f.fireWith(this,arguments),this},fired:function(){return!!o}};return f},S.extend({Deferred:function(e){var o=[["notify","progress",S.Callbacks("memory"),S.Callbacks("memory"),2],["resolve","done",S.Callbacks("once memory"),S.Callbacks("once memory"),0,"resolved"],["reject","fail",S.Callbacks("once memory"),S.Callbacks("once memory"),1,"rejected"]],i="pending",a={state:function(){return i},always:function(){return s.done(arguments).fail(arguments),this},"catch":function(e){return a.then(null,e)},pipe:function(){var i=arguments;return S.Deferred(function(r){S.each(o,function(e,t){var n=m(i[t[4]])&&i[t[4]];s[t[1]](function(){var e=n&&n.apply(this,arguments);e&&m(e.promise)?e.promise().progress(r.notify).done(r.resolve).fail(r.reject):r[t[0]+"With"](this,n?[e]:arguments)})}),i=null}).promise()},then:function(t,n,r){var u=0;function l(i,o,a,s){return function(){var n=this,r=arguments,e=function(){var e,t;if(!(i<u)){if((e=a.apply(n,r))===o.promise())throw new TypeError("Thenable self-resolution");t=e&&("object"==typeof e||"function"==typeof e)&&e.then,m(t)?s?t.call(e,l(u,o,R,s),l(u,o,M,s)):(u++,t.call(e,l(u,o,R,s),l(u,o,M,s),l(u,o,R,o.notifyWith))):(a!==R&&(n=void 0,r=[e]),(s||o.resolveWith)(n,r))}},t=s?e:function(){try{e()}catch(e){S.Deferred.exceptionHook&&S.Deferred.exceptionHook(e,t.stackTrace),u<=i+1&&(a!==M&&(n=void 0,r=[e]),o.rejectWith(n,r))}};i?t():(S.Deferred.getStackHook&&(t.stackTrace=S.Deferred.getStackHook()),C.setTimeout(t))}}return S.Deferred(function(e){o[0][3].add(l(0,e,m(r)?r:R,e.notifyWith)),o[1][3].add(l(0,e,m(t)?t:R)),o[2][3].add(l(0,e,m(n)?n:M))}).promise()},promise:function(e){return null!=e?S.extend(e,a):a}},s={};return S.each(o,function(e,t){var n=t[2],r=t[5];a[t[1]]=n.add,r&&n.add(function(){i=r},o[3-e][2].disable,o[3-e][3].disable,o[0][2].lock,o[0][3].lock),n.add(t[3].fire),s[t[0]]=function(){return s[t[0]+"With"](this===s?void 0:this,arguments),this},s[t[0]+"With"]=n.fireWith}),a.promise(s),e&&e.call(s,s),s},when:function(e){var n=arguments.length,t=n,r=Array(t),i=s.call(arguments),o=S.Deferred(),a=function(t){return function(e){r[t]=this,i[t]=1<arguments.length?s.call(arguments):e,--n||o.resolveWith(r,i)}};if(n<=1&&(I(e,o.done(a(t)).resolve,o.reject,!n),"pending"===o.state()||m(i[t]&&i[t].then)))return o.then();while(t--)I(i[t],a(t),o.reject);return o.promise()}});var W=/^(Eval|Internal|Range|Reference|Syntax|Type|URI)Error$/;S.Deferred.exceptionHook=function(e,t){C.console&&C.console.warn&&e&&W.test(e.name)&&C.console.warn("jQuery.Deferred exception: "+e.message,e.stack,t)},S.readyException=function(e){C.setTimeout(function(){throw e})};var F=S.Deferred();function B(){E.removeEventListener("DOMContentLoaded",B),C.removeEventListener("load",B),S.ready()}S.fn.ready=function(e){return F.then(e)["catch"](function(e){S.readyException(e)}),this},S.extend({isReady:!1,readyWait:1,ready:function(e){(!0===e?--S.readyWait:S.isReady)||(S.isReady=!0)!==e&&0<--S.readyWait||F.resolveWith(E,[S])}}),S.ready.then=F.then,"complete"===E.readyState||"loading"!==E.readyState&&!E.documentElement.doScroll?C.setTimeout(S.ready):(E.addEventListener("DOMContentLoaded",B),C.addEventListener("load",B));var $=function(e,t,n,r,i,o,a){var s=0,u=e.length,l=null==n;if("object"===w(n))for(s in i=!0,n)$(e,t,s,n[s],!0,o,a);else if(void 0!==r&&(i=!0,m(r)||(a=!0),l&&(a?(t.call(e,r),t=null):(l=t,t=function(e,t,n){return l.call(S(e),n)})),t))for(;s<u;s++)t(e[s],n,a?r:r.call(e[s],s,t(e[s],n)));return i?e:l?t.call(e):u?t(e[0],n):o},_=/^-ms-/,z=/-([a-z])/g;function U(e,t){return t.toUpperCase()}function X(e){return e.replace(_,"ms-").replace(z,U)}var V=function(e){return 1===e.nodeType||9===e.nodeType||!+e.nodeType};function G(){this.expando=S.expando+G.uid++}G.uid=1,G.prototype={cache:function(e){var t=e[this.expando];return t||(t={},V(e)&&(e.nodeType?e[this.expando]=t:Object.defineProperty(e,this.expando,{value:t,configurable:!0}))),t},set:function(e,t,n){var r,i=this.cache(e);if("string"==typeof t)i[X(t)]=n;else for(r in t)i[X(r)]=t[r];return i},get:function(e,t){return void 0===t?this.cache(e):e[this.expando]&&e[this.expando][X(t)]},access:function(e,t,n){return void 0===t||t&&"string"==typeof t&&void 0===n?this.get(e,t):(this.set(e,t,n),void 0!==n?n:t)},remove:function(e,t){var n,r=e[this.expando];if(void 0!==r){if(void 0!==t){n=(t=Array.isArray(t)?t.map(X):(t=X(t))in r?[t]:t.match(P)||[]).length;while(n--)delete r[t[n]]}(void 0===t||S.isEmptyObject(r))&&(e.nodeType?e[this.expando]=void 0:delete e[this.expando])}},hasData:function(e){var t=e[this.expando];return void 0!==t&&!S.isEmptyObject(t)}};var Y=new G,Q=new G,J=/^(?:\{[\w\W]*\}|\[[\w\W]*\])$/,K=/[A-Z]/g;function Z(e,t,n){var r,i;if(void 0===n&&1===e.nodeType)if(r="data-"+t.replace(K,"-$&").toLowerCase(),"string"==typeof(n=e.getAttribute(r))){try{n="true"===(i=n)||"false"!==i&&("null"===i?null:i===+i+""?+i:J.test(i)?JSON.parse(i):i)}catch(e){}Q.set(e,t,n)}else n=void 0;return n}S.extend({hasData:function(e){return Q.hasData(e)||Y.hasData(e)},data:function(e,t,n){return Q.access(e,t,n)},removeData:function(e,t){Q.remove(e,t)},_data:function(e,t,n){return Y.access(e,t,n)},_removeData:function(e,t){Y.remove(e,t)}}),S.fn.extend({data:function(n,e){var t,r,i,o=this[0],a=o&&o.attributes;if(void 0===n){if(this.length&&(i=Q.get(o),1===o.nodeType&&!Y.get(o,"hasDataAttrs"))){t=a.length;while(t--)a[t]&&0===(r=a[t].name).indexOf("data-")&&(r=X(r.slice(5)),Z(o,r,i[r]));Y.set(o,"hasDataAttrs",!0)}return i}return"object"==typeof n?this.each(function(){Q.set(this,n)}):$(this,function(e){var t;if(o&&void 0===e)return void 0!==(t=Q.get(o,n))?t:void 0!==(t=Z(o,n))?t:void 0;this.each(function(){Q.set(this,n,e)})},null,e,1<arguments.length,null,!0)},removeData:function(e){return this.each(function(){Q.remove(this,e)})}}),S.extend({queue:function(e,t,n){var r;if(e)return t=(t||"fx")+"queue",r=Y.get(e,t),n&&(!r||Array.isArray(n)?r=Y.access(e,t,S.makeArray(n)):r.push(n)),r||[]},dequeue:function(e,t){t=t||"fx";var n=S.queue(e,t),r=n.length,i=n.shift(),o=S._queueHooks(e,t);"inprogress"===i&&(i=n.shift(),r--),i&&("fx"===t&&n.unshift("inprogress"),delete o.stop,i.call(e,function(){S.dequeue(e,t)},o)),!r&&o&&o.empty.fire()},_queueHooks:function(e,t){var n=t+"queueHooks";return Y.get(e,n)||Y.access(e,n,{empty:S.Callbacks("once memory").add(function(){Y.remove(e,[t+"queue",n])})})}}),S.fn.extend({queue:function(t,n){var e=2;return"string"!=typeof t&&(n=t,t="fx",e--),arguments.length<e?S.queue(this[0],t):void 0===n?this:this.each(function(){var e=S.queue(this,t,n);S._queueHooks(this,t),"fx"===t&&"inprogress"!==e[0]&&S.dequeue(this,t)})},dequeue:function(e){return this.each(function(){S.dequeue(this,e)})},clearQueue:function(e){return this.queue(e||"fx",[])},promise:function(e,t){var n,r=1,i=S.Deferred(),o=this,a=this.length,s=function(){--r||i.resolveWith(o,[o])};"string"!=typeof e&&(t=e,e=void 0),e=e||"fx";while(a--)(n=Y.get(o[a],e+"queueHooks"))&&n.empty&&(r++,n.empty.add(s));return s(),i.promise(t)}});var ee=/[+-]?(?:\d*\.|)\d+(?:[eE][+-]?\d+|)/.source,te=new RegExp("^(?:([+-])=|)("+ee+")([a-z%]*)$","i"),ne=["Top","Right","Bottom","Left"],re=E.documentElement,ie=function(e){return S.contains(e.ownerDocument,e)},oe={composed:!0};re.getRootNode&&(ie=function(e){return S.contains(e.ownerDocument,e)||e.getRootNode(oe)===e.ownerDocument});var ae=function(e,t){return"none"===(e=t||e).style.display||""===e.style.display&&ie(e)&&"none"===S.css(e,"display")};function se(e,t,n,r){var i,o,a=20,s=r?function(){return r.cur()}:function(){return S.css(e,t,"")},u=s(),l=n&&n[3]||(S.cssNumber[t]?"":"px"),c=e.nodeType&&(S.cssNumber[t]||"px"!==l&&+u)&&te.exec(S.css(e,t));if(c&&c[3]!==l){u/=2,l=l||c[3],c=+u||1;while(a--)S.style(e,t,c+l),(1-o)*(1-(o=s()/u||.5))<=0&&(a=0),c/=o;c*=2,S.style(e,t,c+l),n=n||[]}return n&&(c=+c||+u||0,i=n[1]?c+(n[1]+1)*n[2]:+n[2],r&&(r.unit=l,r.start=c,r.end=i)),i}var ue={};function le(e,t){for(var n,r,i,o,a,s,u,l=[],c=0,f=e.length;c<f;c++)(r=e[c]).style&&(n=r.style.display,t?("none"===n&&(l[c]=Y.get(r,"display")||null,l[c]||(r.style.display="")),""===r.style.display&&ae(r)&&(l[c]=(u=a=o=void 0,a=(i=r).ownerDocument,s=i.nodeName,(u=ue[s])||(o=a.body.appendChild(a.createElement(s)),u=S.css(o,"display"),o.parentNode.removeChild(o),"none"===u&&(u="block"),ue[s]=u)))):"none"!==n&&(l[c]="none",Y.set(r,"display",n)));for(c=0;c<f;c++)null!=l[c]&&(e[c].style.display=l[c]);return e}S.fn.extend({show:function(){return le(this,!0)},hide:function(){return le(this)},toggle:function(e){return"boolean"==typeof e?e?this.show():this.hide():this.each(function(){ae(this)?S(this).show():S(this).hide()})}});var ce,fe,pe=/^(?:checkbox|radio)$/i,de=/<([a-z][^\/\0>\x20\t\r\n\f]*)/i,he=/^$|^module$|\/(?:java|ecma)script/i;ce=E.createDocumentFragment().appendChild(E.createElement("div")),(fe=E.createElement("input")).setAttribute("type","radio"),fe.setAttribute("checked","checked"),fe.setAttribute("name","t"),ce.appendChild(fe),y.checkClone=ce.cloneNode(!0).cloneNode(!0).lastChild.checked,ce.innerHTML="<textarea>x</textarea>",y.noCloneChecked=!!ce.cloneNode(!0).lastChild.defaultValue,ce.innerHTML="<option></option>",y.option=!!ce.lastChild;var ge={thead:[1,"<table>","</table>"],col:[2,"<table><colgroup>","</colgroup></table>"],tr:[2,"<table><tbody>","</tbody></table>"],td:[3,"<table><tbody><tr>","</tr></tbody></table>"],_default:[0,"",""]};function ve(e,t){var n;return n="undefined"!=typeof e.getElementsByTagName?e.getElementsByTagName(t||"*"):"undefined"!=typeof e.querySelectorAll?e.querySelectorAll(t||"*"):[],void 0===t||t&&A(e,t)?S.merge([e],n):n}function ye(e,t){for(var n=0,r=e.length;n<r;n++)Y.set(e[n],"globalEval",!t||Y.get(t[n],"globalEval"))}ge.tbody=ge.tfoot=ge.colgroup=ge.caption=ge.thead,ge.th=ge.td,y.option||(ge.optgroup=ge.option=[1,"<select multiple='multiple'>","</select>"]);var me=/<|&#?\w+;/;function xe(e,t,n,r,i){for(var o,a,s,u,l,c,f=t.createDocumentFragment(),p=[],d=0,h=e.length;d<h;d++)if((o=e[d])||0===o)if("object"===w(o))S.merge(p,o.nodeType?[o]:o);else if(me.test(o)){a=a||f.appendChild(t.createElement("div")),s=(de.exec(o)||["",""])[1].toLowerCase(),u=ge[s]||ge._default,a.innerHTML=u[1]+S.htmlPrefilter(o)+u[2],c=u[0];while(c--)a=a.lastChild;S.merge(p,a.childNodes),(a=f.firstChild).textContent=""}else p.push(t.createTextNode(o));f.textContent="",d=0;while(o=p[d++])if(r&&-1<S.inArray(o,r))i&&i.push(o);else if(l=ie(o),a=ve(f.appendChild(o),"script"),l&&ye(a),n){c=0;while(o=a[c++])he.test(o.type||"")&&n.push(o)}return f}var be=/^([^.]*)(?:\.(.+)|)/;function we(){return!0}function Te(){return!1}function Ce(e,t){return e===function(){try{return E.activeElement}catch(e){}}()==("focus"===t)}function Ee(e,t,n,r,i,o){var a,s;if("object"==typeof t){for(s in"string"!=typeof n&&(r=r||n,n=void 0),t)Ee(e,s,n,r,t[s],o);return e}if(null==r&&null==i?(i=n,r=n=void 0):null==i&&("string"==typeof n?(i=r,r=void 0):(i=r,r=n,n=void 0)),!1===i)i=Te;else if(!i)return e;return 1===o&&(a=i,(i=function(e){return S().off(e),a.apply(this,arguments)}).guid=a.guid||(a.guid=S.guid++)),e.each(function(){S.event.add(this,t,i,r,n)})}function Se(e,i,o){o?(Y.set(e,i,!1),S.event.add(e,i,{namespace:!1,handler:function(e){var t,n,r=Y.get(this,i);if(1&e.isTrigger&&this[i]){if(r.length)(S.event.special[i]||{}).delegateType&&e.stopPropagation();else if(r=s.call(arguments),Y.set(this,i,r),t=o(this,i),this[i](),r!==(n=Y.get(this,i))||t?Y.set(this,i,!1):n={},r!==n)return e.stopImmediatePropagation(),e.preventDefault(),n&&n.value}else r.length&&(Y.set(this,i,{value:S.event.trigger(S.extend(r[0],S.Event.prototype),r.slice(1),this)}),e.stopImmediatePropagation())}})):void 0===Y.get(e,i)&&S.event.add(e,i,we)}S.event={global:{},add:function(t,e,n,r,i){var o,a,s,u,l,c,f,p,d,h,g,v=Y.get(t);if(V(t)){n.handler&&(n=(o=n).handler,i=o.selector),i&&S.find.matchesSelector(re,i),n.guid||(n.guid=S.guid++),(u=v.events)||(u=v.events=Object.create(null)),(a=v.handle)||(a=v.handle=function(e){return"undefined"!=typeof S&&S.event.triggered!==e.type?S.event.dispatch.apply(t,arguments):void 0}),l=(e=(e||"").match(P)||[""]).length;while(l--)d=g=(s=be.exec(e[l])||[])[1],h=(s[2]||"").split(".").sort(),d&&(f=S.event.special[d]||{},d=(i?f.delegateType:f.bindType)||d,f=S.event.special[d]||{},c=S.extend({type:d,origType:g,data:r,handler:n,guid:n.guid,selector:i,needsContext:i&&S.expr.match.needsContext.test(i),namespace:h.join(".")},o),(p=u[d])||((p=u[d]=[]).delegateCount=0,f.setup&&!1!==f.setup.call(t,r,h,a)||t.addEventListener&&t.addEventListener(d,a)),f.add&&(f.add.call(t,c),c.handler.guid||(c.handler.guid=n.guid)),i?p.splice(p.delegateCount++,0,c):p.push(c),S.event.global[d]=!0)}},remove:function(e,t,n,r,i){var o,a,s,u,l,c,f,p,d,h,g,v=Y.hasData(e)&&Y.get(e);if(v&&(u=v.events)){l=(t=(t||"").match(P)||[""]).length;while(l--)if(d=g=(s=be.exec(t[l])||[])[1],h=(s[2]||"").split(".").sort(),d){f=S.event.special[d]||{},p=u[d=(r?f.delegateType:f.bindType)||d]||[],s=s[2]&&new RegExp("(^|\\.)"+h.join("\\.(?:.*\\.|)")+"(\\.|$)"),a=o=p.length;while(o--)c=p[o],!i&&g!==c.origType||n&&n.guid!==c.guid||s&&!s.test(c.namespace)||r&&r!==c.selector&&("**"!==r||!c.selector)||(p.splice(o,1),c.selector&&p.delegateCount--,f.remove&&f.remove.call(e,c));a&&!p.length&&(f.teardown&&!1!==f.teardown.call(e,h,v.handle)||S.removeEvent(e,d,v.handle),delete u[d])}else for(d in u)S.event.remove(e,d+t[l],n,r,!0);S.isEmptyObject(u)&&Y.remove(e,"handle events")}},dispatch:function(e){var t,n,r,i,o,a,s=new Array(arguments.length),u=S.event.fix(e),l=(Y.get(this,"events")||Object.create(null))[u.type]||[],c=S.event.special[u.type]||{};for(s[0]=u,t=1;t<arguments.length;t++)s[t]=arguments[t];if(u.delegateTarget=this,!c.preDispatch||!1!==c.preDispatch.call(this,u)){a=S.event.handlers.call(this,u,l),t=0;while((i=a[t++])&&!u.isPropagationStopped()){u.currentTarget=i.elem,n=0;while((o=i.handlers[n++])&&!u.isImmediatePropagationStopped())u.rnamespace&&!1!==o.namespace&&!u.rnamespace.test(o.namespace)||(u.handleObj=o,u.data=o.data,void 0!==(r=((S.event.special[o.origType]||{}).handle||o.handler).apply(i.elem,s))&&!1===(u.result=r)&&(u.preventDefault(),u.stopPropagation()))}return c.postDispatch&&c.postDispatch.call(this,u),u.result}},handlers:function(e,t){var n,r,i,o,a,s=[],u=t.delegateCount,l=e.target;if(u&&l.nodeType&&!("click"===e.type&&1<=e.button))for(;l!==this;l=l.parentNode||this)if(1===l.nodeType&&("click"!==e.type||!0!==l.disabled)){for(o=[],a={},n=0;n<u;n++)void 0===a[i=(r=t[n]).selector+" "]&&(a[i]=r.needsContext?-1<S(i,this).index(l):S.find(i,this,null,[l]).length),a[i]&&o.push(r);o.length&&s.push({elem:l,handlers:o})}return l=this,u<t.length&&s.push({elem:l,handlers:t.slice(u)}),s},addProp:function(t,e){Object.defineProperty(S.Event.prototype,t,{enumerable:!0,configurable:!0,get:m(e)?function(){if(this.originalEvent)return e(this.originalEvent)}:function(){if(this.originalEvent)return this.originalEvent[t]},set:function(e){Object.defineProperty(this,t,{enumerable:!0,configurable:!0,writable:!0,value:e})}})},fix:function(e){return e[S.expando]?e:new S.Event(e)},special:{load:{noBubble:!0},click:{setup:function(e){var t=this||e;return pe.test(t.type)&&t.click&&A(t,"input")&&Se(t,"click",we),!1},trigger:function(e){var t=this||e;return pe.test(t.type)&&t.click&&A(t,"input")&&Se(t,"click"),!0},_default:function(e){var t=e.target;return pe.test(t.type)&&t.click&&A(t,"input")&&Y.get(t,"click")||A(t,"a")}},beforeunload:{postDispatch:function(e){void 0!==e.result&&e.originalEvent&&(e.originalEvent.returnValue=e.result)}}}},S.removeEvent=function(e,t,n){e.removeEventListener&&e.removeEventListener(t,n)},S.Event=function(e,t){if(!(this instanceof S.Event))return new S.Event(e,t);e&&e.type?(this.originalEvent=e,this.type=e.type,this.isDefaultPrevented=e.defaultPrevented||void 0===e.defaultPrevented&&!1===e.returnValue?we:Te,this.target=e.target&&3===e.target.nodeType?e.target.parentNode:e.target,this.currentTarget=e.currentTarget,this.relatedTarget=e.relatedTarget):this.type=e,t&&S.extend(this,t),this.timeStamp=e&&e.timeStamp||Date.now(),this[S.expando]=!0},S.Event.prototype={constructor:S.Event,isDefaultPrevented:Te,isPropagationStopped:Te,isImmediatePropagationStopped:Te,isSimulated:!1,preventDefault:function(){var e=this.originalEvent;this.isDefaultPrevented=we,e&&!this.isSimulated&&e.preventDefault()},stopPropagation:function(){var e=this.originalEvent;this.isPropagationStopped=we,e&&!this.isSimulated&&e.stopPropagation()},stopImmediatePropagation:function(){var e=this.originalEvent;this.isImmediatePropagationStopped=we,e&&!this.isSimulated&&e.stopImmediatePropagation(),this.stopPropagation()}},S.each({altKey:!0,bubbles:!0,cancelable:!0,changedTouches:!0,ctrlKey:!0,detail:!0,eventPhase:!0,metaKey:!0,pageX:!0,pageY:!0,shiftKey:!0,view:!0,"char":!0,code:!0,charCode:!0,key:!0,keyCode:!0,button:!0,buttons:!0,clientX:!0,clientY:!0,offsetX:!0,offsetY:!0,pointerId:!0,pointerType:!0,screenX:!0,screenY:!0,targetTouches:!0,toElement:!0,touches:!0,which:!0},S.event.addProp),S.each({focus:"focusin",blur:"focusout"},function(e,t){S.event.special[e]={setup:function(){return Se(this,e,Ce),!1},trigger:function(){return Se(this,e),!0},_default:function(){return!0},delegateType:t}}),S.each({mouseenter:"mouseover",mouseleave:"mouseout",pointerenter:"pointerover",pointerleave:"pointerout"},function(e,i){S.event.special[e]={delegateType:i,bindType:i,handle:function(e){var t,n=e.relatedTarget,r=e.handleObj;return n&&(n===this||S.contains(this,n))||(e.type=r.origType,t=r.handler.apply(this,arguments),e.type=i),t}}}),S.fn.extend({on:function(e,t,n,r){return Ee(this,e,t,n,r)},one:function(e,t,n,r){return Ee(this,e,t,n,r,1)},off:function(e,t,n){var r,i;if(e&&e.preventDefault&&e.handleObj)return r=e.handleObj,S(e.delegateTarget).off(r.namespace?r.origType+"."+r.namespace:r.origType,r.selector,r.handler),this;if("object"==typeof e){for(i in e)this.off(i,t,e[i]);return this}return!1!==t&&"function"!=typeof t||(n=t,t=void 0),!1===n&&(n=Te),this.each(function(){S.event.remove(this,e,n,t)})}});var ke=/<script|<style|<link/i,Ae=/checked\s*(?:[^=]|=\s*.checked.)/i,Ne=/^\s*<!(?:\[CDATA\[|--)|(?:\]\]|--)>\s*$/g;function je(e,t){return A(e,"table")&&A(11!==t.nodeType?t:t.firstChild,"tr")&&S(e).children("tbody")[0]||e}function De(e){return e.type=(null!==e.getAttribute("type"))+"/"+e.type,e}function qe(e){return"true/"===(e.type||"").slice(0,5)?e.type=e.type.slice(5):e.removeAttribute("type"),e}function Le(e,t){var n,r,i,o,a,s;if(1===t.nodeType){if(Y.hasData(e)&&(s=Y.get(e).events))for(i in Y.remove(t,"handle events"),s)for(n=0,r=s[i].length;n<r;n++)S.event.add(t,i,s[i][n]);Q.hasData(e)&&(o=Q.access(e),a=S.extend({},o),Q.set(t,a))}}function He(n,r,i,o){r=g(r);var e,t,a,s,u,l,c=0,f=n.length,p=f-1,d=r[0],h=m(d);if(h||1<f&&"string"==typeof d&&!y.checkClone&&Ae.test(d))return n.each(function(e){var t=n.eq(e);h&&(r[0]=d.call(this,e,t.html())),He(t,r,i,o)});if(f&&(t=(e=xe(r,n[0].ownerDocument,!1,n,o)).firstChild,1===e.childNodes.length&&(e=t),t||o)){for(s=(a=S.map(ve(e,"script"),De)).length;c<f;c++)u=e,c!==p&&(u=S.clone(u,!0,!0),s&&S.merge(a,ve(u,"script"))),i.call(n[c],u,c);if(s)for(l=a[a.length-1].ownerDocument,S.map(a,qe),c=0;c<s;c++)u=a[c],he.test(u.type||"")&&!Y.access(u,"globalEval")&&S.contains(l,u)&&(u.src&&"module"!==(u.type||"").toLowerCase()?S._evalUrl&&!u.noModule&&S._evalUrl(u.src,{nonce:u.nonce||u.getAttribute("nonce")},l):b(u.textContent.replace(Ne,""),u,l))}return n}function Oe(e,t,n){for(var r,i=t?S.filter(t,e):e,o=0;null!=(r=i[o]);o++)n||1!==r.nodeType||S.cleanData(ve(r)),r.parentNode&&(n&&ie(r)&&ye(ve(r,"script")),r.parentNode.removeChild(r));return e}S.extend({htmlPrefilter:function(e){return e},clone:function(e,t,n){var r,i,o,a,s,u,l,c=e.cloneNode(!0),f=ie(e);if(!(y.noCloneChecked||1!==e.nodeType&&11!==e.nodeType||S.isXMLDoc(e)))for(a=ve(c),r=0,i=(o=ve(e)).length;r<i;r++)s=o[r],u=a[r],void 0,"input"===(l=u.nodeName.toLowerCase())&&pe.test(s.type)?u.checked=s.checked:"input"!==l&&"textarea"!==l||(u.defaultValue=s.defaultValue);if(t)if(n)for(o=o||ve(e),a=a||ve(c),r=0,i=o.length;r<i;r++)Le(o[r],a[r]);else Le(e,c);return 0<(a=ve(c,"script")).length&&ye(a,!f&&ve(e,"script")),c},cleanData:function(e){for(var t,n,r,i=S.event.special,o=0;void 0!==(n=e[o]);o++)if(V(n)){if(t=n[Y.expando]){if(t.events)for(r in t.events)i[r]?S.event.remove(n,r):S.removeEvent(n,r,t.handle);n[Y.expando]=void 0}n[Q.expando]&&(n[Q.expando]=void 0)}}}),S.fn.extend({detach:function(e){return Oe(this,e,!0)},remove:function(e){return Oe(this,e)},text:function(e){return $(this,function(e){return void 0===e?S.text(this):this.empty().each(function(){1!==this.nodeType&&11!==this.nodeType&&9!==this.nodeType||(this.textContent=e)})},null,e,arguments.length)},append:function(){return He(this,arguments,function(e){1!==this.nodeType&&11!==this.nodeType&&9!==this.nodeType||je(this,e).appendChild(e)})},prepend:function(){return He(this,arguments,function(e){if(1===this.nodeType||11===this.nodeType||9===this.nodeType){var t=je(this,e);t.insertBefore(e,t.firstChild)}})},before:function(){return He(this,arguments,function(e){this.parentNode&&this.parentNode.insertBefore(e,this)})},after:function(){return He(this,arguments,function(e){this.parentNode&&this.parentNode.insertBefore(e,this.nextSibling)})},empty:function(){for(var e,t=0;null!=(e=this[t]);t++)1===e.nodeType&&(S.cleanData(ve(e,!1)),e.textContent="");return this},clone:function(e,t){return e=null!=e&&e,t=null==t?e:t,this.map(function(){return S.clone(this,e,t)})},html:function(e){return $(this,function(e){var t=this[0]||{},n=0,r=this.length;if(void 0===e&&1===t.nodeType)return t.innerHTML;if("string"==typeof e&&!ke.test(e)&&!ge[(de.exec(e)||["",""])[1].toLowerCase()]){e=S.htmlPrefilter(e);try{for(;n<r;n++)1===(t=this[n]||{}).nodeType&&(S.cleanData(ve(t,!1)),t.innerHTML=e);t=0}catch(e){}}t&&this.empty().append(e)},null,e,arguments.length)},replaceWith:function(){var n=[];return He(this,arguments,function(e){var t=this.parentNode;S.inArray(this,n)<0&&(S.cleanData(ve(this)),t&&t.replaceChild(e,this))},n)}}),S.each({appendTo:"append",prependTo:"prepend",insertBefore:"before",insertAfter:"after",replaceAll:"replaceWith"},function(e,a){S.fn[e]=function(e){for(var t,n=[],r=S(e),i=r.length-1,o=0;o<=i;o++)t=o===i?this:this.clone(!0),S(r[o])[a](t),u.apply(n,t.get());return this.pushStack(n)}});var Pe=new RegExp("^("+ee+")(?!px)[a-z%]+$","i"),Re=function(e){var t=e.ownerDocument.defaultView;return t&&t.opener||(t=C),t.getComputedStyle(e)},Me=function(e,t,n){var r,i,o={};for(i in t)o[i]=e.style[i],e.style[i]=t[i];for(i in r=n.call(e),t)e.style[i]=o[i];return r},Ie=new RegExp(ne.join("|"),"i");function We(e,t,n){var r,i,o,a,s=e.style;return(n=n||Re(e))&&(""!==(a=n.getPropertyValue(t)||n[t])||ie(e)||(a=S.style(e,t)),!y.pixelBoxStyles()&&Pe.test(a)&&Ie.test(t)&&(r=s.width,i=s.minWidth,o=s.maxWidth,s.minWidth=s.maxWidth=s.width=a,a=n.width,s.width=r,s.minWidth=i,s.maxWidth=o)),void 0!==a?a+"":a}function Fe(e,t){return{get:function(){if(!e())return(this.get=t).apply(this,arguments);delete this.get}}}!function(){function e(){if(l){u.style.cssText="position:absolute;left:-11111px;width:60px;margin-top:1px;padding:0;border:0",l.style.cssText="position:relative;display:block;box-sizing:border-box;overflow:scroll;margin:auto;border:1px;padding:1px;width:60%;top:1%",re.appendChild(u).appendChild(l);var e=C.getComputedStyle(l);n="1%"!==e.top,s=12===t(e.marginLeft),l.style.right="60%",o=36===t(e.right),r=36===t(e.width),l.style.position="absolute",i=12===t(l.offsetWidth/3),re.removeChild(u),l=null}}function t(e){return Math.round(parseFloat(e))}var n,r,i,o,a,s,u=E.createElement("div"),l=E.createElement("div");l.style&&(l.style.backgroundClip="content-box",l.cloneNode(!0).style.backgroundClip="",y.clearCloneStyle="content-box"===l.style.backgroundClip,S.extend(y,{boxSizingReliable:function(){return e(),r},pixelBoxStyles:function(){return e(),o},pixelPosition:function(){return e(),n},reliableMarginLeft:function(){return e(),s},scrollboxSize:function(){return e(),i},reliableTrDimensions:function(){var e,t,n,r;return null==a&&(e=E.createElement("table"),t=E.createElement("tr"),n=E.createElement("div"),e.style.cssText="position:absolute;left:-11111px;border-collapse:separate",t.style.cssText="border:1px solid",t.style.height="1px",n.style.height="9px",n.style.display="block",re.appendChild(e).appendChild(t).appendChild(n),r=C.getComputedStyle(t),a=parseInt(r.height,10)+parseInt(r.borderTopWidth,10)+parseInt(r.borderBottomWidth,10)===t.offsetHeight,re.removeChild(e)),a}}))}();var Be=["Webkit","Moz","ms"],$e=E.createElement("div").style,_e={};function ze(e){var t=S.cssProps[e]||_e[e];return t||(e in $e?e:_e[e]=function(e){var t=e[0].toUpperCase()+e.slice(1),n=Be.length;while(n--)if((e=Be[n]+t)in $e)return e}(e)||e)}var Ue=/^(none|table(?!-c[ea]).+)/,Xe=/^--/,Ve={position:"absolute",visibility:"hidden",display:"block"},Ge={letterSpacing:"0",fontWeight:"400"};function Ye(e,t,n){var r=te.exec(t);return r?Math.max(0,r[2]-(n||0))+(r[3]||"px"):t}function Qe(e,t,n,r,i,o){var a="width"===t?1:0,s=0,u=0;if(n===(r?"border":"content"))return 0;for(;a<4;a+=2)"margin"===n&&(u+=S.css(e,n+ne[a],!0,i)),r?("content"===n&&(u-=S.css(e,"padding"+ne[a],!0,i)),"margin"!==n&&(u-=S.css(e,"border"+ne[a]+"Width",!0,i))):(u+=S.css(e,"padding"+ne[a],!0,i),"padding"!==n?u+=S.css(e,"border"+ne[a]+"Width",!0,i):s+=S.css(e,"border"+ne[a]+"Width",!0,i));return!r&&0<=o&&(u+=Math.max(0,Math.ceil(e["offset"+t[0].toUpperCase()+t.slice(1)]-o-u-s-.5))||0),u}function Je(e,t,n){var r=Re(e),i=(!y.boxSizingReliable()||n)&&"border-box"===S.css(e,"boxSizing",!1,r),o=i,a=We(e,t,r),s="offset"+t[0].toUpperCase()+t.slice(1);if(Pe.test(a)){if(!n)return a;a="auto"}return(!y.boxSizingReliable()&&i||!y.reliableTrDimensions()&&A(e,"tr")||"auto"===a||!parseFloat(a)&&"inline"===S.css(e,"display",!1,r))&&e.getClientRects().length&&(i="border-box"===S.css(e,"boxSizing",!1,r),(o=s in e)&&(a=e[s])),(a=parseFloat(a)||0)+Qe(e,t,n||(i?"border":"content"),o,r,a)+"px"}function Ke(e,t,n,r,i){return new Ke.prototype.init(e,t,n,r,i)}S.extend({cssHooks:{opacity:{get:function(e,t){if(t){var n=We(e,"opacity");return""===n?"1":n}}}},cssNumber:{animationIterationCount:!0,columnCount:!0,fillOpacity:!0,flexGrow:!0,flexShrink:!0,fontWeight:!0,gridArea:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnStart:!0,gridRow:!0,gridRowEnd:!0,gridRowStart:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,widows:!0,zIndex:!0,zoom:!0},cssProps:{},style:function(e,t,n,r){if(e&&3!==e.nodeType&&8!==e.nodeType&&e.style){var i,o,a,s=X(t),u=Xe.test(t),l=e.style;if(u||(t=ze(s)),a=S.cssHooks[t]||S.cssHooks[s],void 0===n)return a&&"get"in a&&void 0!==(i=a.get(e,!1,r))?i:l[t];"string"===(o=typeof n)&&(i=te.exec(n))&&i[1]&&(n=se(e,t,i),o="number"),null!=n&&n==n&&("number"!==o||u||(n+=i&&i[3]||(S.cssNumber[s]?"":"px")),y.clearCloneStyle||""!==n||0!==t.indexOf("background")||(l[t]="inherit"),a&&"set"in a&&void 0===(n=a.set(e,n,r))||(u?l.setProperty(t,n):l[t]=n))}},css:function(e,t,n,r){var i,o,a,s=X(t);return Xe.test(t)||(t=ze(s)),(a=S.cssHooks[t]||S.cssHooks[s])&&"get"in a&&(i=a.get(e,!0,n)),void 0===i&&(i=We(e,t,r)),"normal"===i&&t in Ge&&(i=Ge[t]),""===n||n?(o=parseFloat(i),!0===n||isFinite(o)?o||0:i):i}}),S.each(["height","width"],function(e,u){S.cssHooks[u]={get:function(e,t,n){if(t)return!Ue.test(S.css(e,"display"))||e.getClientRects().length&&e.getBoundingClientRect().width?Je(e,u,n):Me(e,Ve,function(){return Je(e,u,n)})},set:function(e,t,n){var r,i=Re(e),o=!y.scrollboxSize()&&"absolute"===i.position,a=(o||n)&&"border-box"===S.css(e,"boxSizing",!1,i),s=n?Qe(e,u,n,a,i):0;return a&&o&&(s-=Math.ceil(e["offset"+u[0].toUpperCase()+u.slice(1)]-parseFloat(i[u])-Qe(e,u,"border",!1,i)-.5)),s&&(r=te.exec(t))&&"px"!==(r[3]||"px")&&(e.style[u]=t,t=S.css(e,u)),Ye(0,t,s)}}}),S.cssHooks.marginLeft=Fe(y.reliableMarginLeft,function(e,t){if(t)return(parseFloat(We(e,"marginLeft"))||e.getBoundingClientRect().left-Me(e,{marginLeft:0},function(){return e.getBoundingClientRect().left}))+"px"}),S.each({margin:"",padding:"",border:"Width"},function(i,o){S.cssHooks[i+o]={expand:function(e){for(var t=0,n={},r="string"==typeof e?e.split(" "):[e];t<4;t++)n[i+ne[t]+o]=r[t]||r[t-2]||r[0];return n}},"margin"!==i&&(S.cssHooks[i+o].set=Ye)}),S.fn.extend({css:function(e,t){return $(this,function(e,t,n){var r,i,o={},a=0;if(Array.isArray(t)){for(r=Re(e),i=t.length;a<i;a++)o[t[a]]=S.css(e,t[a],!1,r);return o}return void 0!==n?S.style(e,t,n):S.css(e,t)},e,t,1<arguments.length)}}),((S.Tween=Ke).prototype={constructor:Ke,init:function(e,t,n,r,i,o){this.elem=e,this.prop=n,this.easing=i||S.easing._default,this.options=t,this.start=this.now=this.cur(),this.end=r,this.unit=o||(S.cssNumber[n]?"":"px")},cur:function(){var e=Ke.propHooks[this.prop];return e&&e.get?e.get(this):Ke.propHooks._default.get(this)},run:function(e){var t,n=Ke.propHooks[this.prop];return this.options.duration?this.pos=t=S.easing[this.easing](e,this.options.duration*e,0,1,this.options.duration):this.pos=t=e,this.now=(this.end-this.start)*t+this.start,this.options.step&&this.options.step.call(this.elem,this.now,this),n&&n.set?n.set(this):Ke.propHooks._default.set(this),this}}).init.prototype=Ke.prototype,(Ke.propHooks={_default:{get:function(e){var t;return 1!==e.elem.nodeType||null!=e.elem[e.prop]&&null==e.elem.style[e.prop]?e.elem[e.prop]:(t=S.css(e.elem,e.prop,""))&&"auto"!==t?t:0},set:function(e){S.fx.step[e.prop]?S.fx.step[e.prop](e):1!==e.elem.nodeType||!S.cssHooks[e.prop]&&null==e.elem.style[ze(e.prop)]?e.elem[e.prop]=e.now:S.style(e.elem,e.prop,e.now+e.unit)}}}).scrollTop=Ke.propHooks.scrollLeft={set:function(e){e.elem.nodeType&&e.elem.parentNode&&(e.elem[e.prop]=e.now)}},S.easing={linear:function(e){return e},swing:function(e){return.5-Math.cos(e*Math.PI)/2},_default:"swing"},S.fx=Ke.prototype.init,S.fx.step={};var Ze,et,tt,nt,rt=/^(?:toggle|show|hide)$/,it=/queueHooks$/;function ot(){et&&(!1===E.hidden&&C.requestAnimationFrame?C.requestAnimationFrame(ot):C.setTimeout(ot,S.fx.interval),S.fx.tick())}function at(){return C.setTimeout(function(){Ze=void 0}),Ze=Date.now()}function st(e,t){var n,r=0,i={height:e};for(t=t?1:0;r<4;r+=2-t)i["margin"+(n=ne[r])]=i["padding"+n]=e;return t&&(i.opacity=i.width=e),i}function ut(e,t,n){for(var r,i=(lt.tweeners[t]||[]).concat(lt.tweeners["*"]),o=0,a=i.length;o<a;o++)if(r=i[o].call(n,t,e))return r}function lt(o,e,t){var n,a,r=0,i=lt.prefilters.length,s=S.Deferred().always(function(){delete u.elem}),u=function(){if(a)return!1;for(var e=Ze||at(),t=Math.max(0,l.startTime+l.duration-e),n=1-(t/l.duration||0),r=0,i=l.tweens.length;r<i;r++)l.tweens[r].run(n);return s.notifyWith(o,[l,n,t]),n<1&&i?t:(i||s.notifyWith(o,[l,1,0]),s.resolveWith(o,[l]),!1)},l=s.promise({elem:o,props:S.extend({},e),opts:S.extend(!0,{specialEasing:{},easing:S.easing._default},t),originalProperties:e,originalOptions:t,startTime:Ze||at(),duration:t.duration,tweens:[],createTween:function(e,t){var n=S.Tween(o,l.opts,e,t,l.opts.specialEasing[e]||l.opts.easing);return l.tweens.push(n),n},stop:function(e){var t=0,n=e?l.tweens.length:0;if(a)return this;for(a=!0;t<n;t++)l.tweens[t].run(1);return e?(s.notifyWith(o,[l,1,0]),s.resolveWith(o,[l,e])):s.rejectWith(o,[l,e]),this}}),c=l.props;for(!function(e,t){var n,r,i,o,a;for(n in e)if(i=t[r=X(n)],o=e[n],Array.isArray(o)&&(i=o[1],o=e[n]=o[0]),n!==r&&(e[r]=o,delete e[n]),(a=S.cssHooks[r])&&"expand"in a)for(n in o=a.expand(o),delete e[r],o)n in e||(e[n]=o[n],t[n]=i);else t[r]=i}(c,l.opts.specialEasing);r<i;r++)if(n=lt.prefilters[r].call(l,o,c,l.opts))return m(n.stop)&&(S._queueHooks(l.elem,l.opts.queue).stop=n.stop.bind(n)),n;return S.map(c,ut,l),m(l.opts.start)&&l.opts.start.call(o,l),l.progress(l.opts.progress).done(l.opts.done,l.opts.complete).fail(l.opts.fail).always(l.opts.always),S.fx.timer(S.extend(u,{elem:o,anim:l,queue:l.opts.queue})),l}S.Animation=S.extend(lt,{tweeners:{"*":[function(e,t){var n=this.createTween(e,t);return se(n.elem,e,te.exec(t),n),n}]},tweener:function(e,t){m(e)?(t=e,e=["*"]):e=e.match(P);for(var n,r=0,i=e.length;r<i;r++)n=e[r],lt.tweeners[n]=lt.tweeners[n]||[],lt.tweeners[n].unshift(t)},prefilters:[function(e,t,n){var r,i,o,a,s,u,l,c,f="width"in t||"height"in t,p=this,d={},h=e.style,g=e.nodeType&&ae(e),v=Y.get(e,"fxshow");for(r in n.queue||(null==(a=S._queueHooks(e,"fx")).unqueued&&(a.unqueued=0,s=a.empty.fire,a.empty.fire=function(){a.unqueued||s()}),a.unqueued++,p.always(function(){p.always(function(){a.unqueued--,S.queue(e,"fx").length||a.empty.fire()})})),t)if(i=t[r],rt.test(i)){if(delete t[r],o=o||"toggle"===i,i===(g?"hide":"show")){if("show"!==i||!v||void 0===v[r])continue;g=!0}d[r]=v&&v[r]||S.style(e,r)}if((u=!S.isEmptyObject(t))||!S.isEmptyObject(d))for(r in f&&1===e.nodeType&&(n.overflow=[h.overflow,h.overflowX,h.overflowY],null==(l=v&&v.display)&&(l=Y.get(e,"display")),"none"===(c=S.css(e,"display"))&&(l?c=l:(le([e],!0),l=e.style.display||l,c=S.css(e,"display"),le([e]))),("inline"===c||"inline-block"===c&&null!=l)&&"none"===S.css(e,"float")&&(u||(p.done(function(){h.display=l}),null==l&&(c=h.display,l="none"===c?"":c)),h.display="inline-block")),n.overflow&&(h.overflow="hidden",p.always(function(){h.overflow=n.overflow[0],h.overflowX=n.overflow[1],h.overflowY=n.overflow[2]})),u=!1,d)u||(v?"hidden"in v&&(g=v.hidden):v=Y.access(e,"fxshow",{display:l}),o&&(v.hidden=!g),g&&le([e],!0),p.done(function(){for(r in g||le([e]),Y.remove(e,"fxshow"),d)S.style(e,r,d[r])})),u=ut(g?v[r]:0,r,p),r in v||(v[r]=u.start,g&&(u.end=u.start,u.start=0))}],prefilter:function(e,t){t?lt.prefilters.unshift(e):lt.prefilters.push(e)}}),S.speed=function(e,t,n){var r=e&&"object"==typeof e?S.extend({},e):{complete:n||!n&&t||m(e)&&e,duration:e,easing:n&&t||t&&!m(t)&&t};return S.fx.off?r.duration=0:"number"!=typeof r.duration&&(r.duration in S.fx.speeds?r.duration=S.fx.speeds[r.duration]:r.duration=S.fx.speeds._default),null!=r.queue&&!0!==r.queue||(r.queue="fx"),r.old=r.complete,r.complete=function(){m(r.old)&&r.old.call(this),r.queue&&S.dequeue(this,r.queue)},r},S.fn.extend({fadeTo:function(e,t,n,r){return this.filter(ae).css("opacity",0).show().end().animate({opacity:t},e,n,r)},animate:function(t,e,n,r){var i=S.isEmptyObject(t),o=S.speed(e,n,r),a=function(){var e=lt(this,S.extend({},t),o);(i||Y.get(this,"finish"))&&e.stop(!0)};return a.finish=a,i||!1===o.queue?this.each(a):this.queue(o.queue,a)},stop:function(i,e,o){var a=function(e){var t=e.stop;delete e.stop,t(o)};return"string"!=typeof i&&(o=e,e=i,i=void 0),e&&this.queue(i||"fx",[]),this.each(function(){var e=!0,t=null!=i&&i+"queueHooks",n=S.timers,r=Y.get(this);if(t)r[t]&&r[t].stop&&a(r[t]);else for(t in r)r[t]&&r[t].stop&&it.test(t)&&a(r[t]);for(t=n.length;t--;)n[t].elem!==this||null!=i&&n[t].queue!==i||(n[t].anim.stop(o),e=!1,n.splice(t,1));!e&&o||S.dequeue(this,i)})},finish:function(a){return!1!==a&&(a=a||"fx"),this.each(function(){var e,t=Y.get(this),n=t[a+"queue"],r=t[a+"queueHooks"],i=S.timers,o=n?n.length:0;for(t.finish=!0,S.queue(this,a,[]),r&&r.stop&&r.stop.call(this,!0),e=i.length;e--;)i[e].elem===this&&i[e].queue===a&&(i[e].anim.stop(!0),i.splice(e,1));for(e=0;e<o;e++)n[e]&&n[e].finish&&n[e].finish.call(this);delete t.finish})}}),S.each(["toggle","show","hide"],function(e,r){var i=S.fn[r];S.fn[r]=function(e,t,n){return null==e||"boolean"==typeof e?i.apply(this,arguments):this.animate(st(r,!0),e,t,n)}}),S.each({slideDown:st("show"),slideUp:st("hide"),slideToggle:st("toggle"),fadeIn:{opacity:"show"},fadeOut:{opacity:"hide"},fadeToggle:{opacity:"toggle"}},function(e,r){S.fn[e]=function(e,t,n){return this.animate(r,e,t,n)}}),S.timers=[],S.fx.tick=function(){var e,t=0,n=S.timers;for(Ze=Date.now();t<n.length;t++)(e=n[t])()||n[t]!==e||n.splice(t--,1);n.length||S.fx.stop(),Ze=void 0},S.fx.timer=function(e){S.timers.push(e),S.fx.start()},S.fx.interval=13,S.fx.start=function(){et||(et=!0,ot())},S.fx.stop=function(){et=null},S.fx.speeds={slow:600,fast:200,_default:400},S.fn.delay=function(r,e){return r=S.fx&&S.fx.speeds[r]||r,e=e||"fx",this.queue(e,function(e,t){var n=C.setTimeout(e,r);t.stop=function(){C.clearTimeout(n)}})},tt=E.createElement("input"),nt=E.createElement("select").appendChild(E.createElement("option")),tt.type="checkbox",y.checkOn=""!==tt.value,y.optSelected=nt.selected,(tt=E.createElement("input")).value="t",tt.type="radio",y.radioValue="t"===tt.value;var ct,ft=S.expr.attrHandle;S.fn.extend({attr:function(e,t){return $(this,S.attr,e,t,1<arguments.length)},removeAttr:function(e){return this.each(function(){S.removeAttr(this,e)})}}),S.extend({attr:function(e,t,n){var r,i,o=e.nodeType;if(3!==o&&8!==o&&2!==o)return"undefined"==typeof e.getAttribute?S.prop(e,t,n):(1===o&&S.isXMLDoc(e)||(i=S.attrHooks[t.toLowerCase()]||(S.expr.match.bool.test(t)?ct:void 0)),void 0!==n?null===n?void S.removeAttr(e,t):i&&"set"in i&&void 0!==(r=i.set(e,n,t))?r:(e.setAttribute(t,n+""),n):i&&"get"in i&&null!==(r=i.get(e,t))?r:null==(r=S.find.attr(e,t))?void 0:r)},attrHooks:{type:{set:function(e,t){if(!y.radioValue&&"radio"===t&&A(e,"input")){var n=e.value;return e.setAttribute("type",t),n&&(e.value=n),t}}}},removeAttr:function(e,t){var n,r=0,i=t&&t.match(P);if(i&&1===e.nodeType)while(n=i[r++])e.removeAttribute(n)}}),ct={set:function(e,t,n){return!1===t?S.removeAttr(e,n):e.setAttribute(n,n),n}},S.each(S.expr.match.bool.source.match(/\w+/g),function(e,t){var a=ft[t]||S.find.attr;ft[t]=function(e,t,n){var r,i,o=t.toLowerCase();return n||(i=ft[o],ft[o]=r,r=null!=a(e,t,n)?o:null,ft[o]=i),r}});var pt=/^(?:input|select|textarea|button)$/i,dt=/^(?:a|area)$/i;function ht(e){return(e.match(P)||[]).join(" ")}function gt(e){return e.getAttribute&&e.getAttribute("class")||""}function vt(e){return Array.isArray(e)?e:"string"==typeof e&&e.match(P)||[]}S.fn.extend({prop:function(e,t){return $(this,S.prop,e,t,1<arguments.length)},removeProp:function(e){return this.each(function(){delete this[S.propFix[e]||e]})}}),S.extend({prop:function(e,t,n){var r,i,o=e.nodeType;if(3!==o&&8!==o&&2!==o)return 1===o&&S.isXMLDoc(e)||(t=S.propFix[t]||t,i=S.propHooks[t]),void 0!==n?i&&"set"in i&&void 0!==(r=i.set(e,n,t))?r:e[t]=n:i&&"get"in i&&null!==(r=i.get(e,t))?r:e[t]},propHooks:{tabIndex:{get:function(e){var t=S.find.attr(e,"tabindex");return t?parseInt(t,10):pt.test(e.nodeName)||dt.test(e.nodeName)&&e.href?0:-1}}},propFix:{"for":"htmlFor","class":"className"}}),y.optSelected||(S.propHooks.selected={get:function(e){var t=e.parentNode;return t&&t.parentNode&&t.parentNode.selectedIndex,null},set:function(e){var t=e.parentNode;t&&(t.selectedIndex,t.parentNode&&t.parentNode.selectedIndex)}}),S.each(["tabIndex","readOnly","maxLength","cellSpacing","cellPadding","rowSpan","colSpan","useMap","frameBorder","contentEditable"],function(){S.propFix[this.toLowerCase()]=this}),S.fn.extend({addClass:function(t){var e,n,r,i,o,a,s,u=0;if(m(t))return this.each(function(e){S(this).addClass(t.call(this,e,gt(this)))});if((e=vt(t)).length)while(n=this[u++])if(i=gt(n),r=1===n.nodeType&&" "+ht(i)+" "){a=0;while(o=e[a++])r.indexOf(" "+o+" ")<0&&(r+=o+" ");i!==(s=ht(r))&&n.setAttribute("class",s)}return this},removeClass:function(t){var e,n,r,i,o,a,s,u=0;if(m(t))return this.each(function(e){S(this).removeClass(t.call(this,e,gt(this)))});if(!arguments.length)return this.attr("class","");if((e=vt(t)).length)while(n=this[u++])if(i=gt(n),r=1===n.nodeType&&" "+ht(i)+" "){a=0;while(o=e[a++])while(-1<r.indexOf(" "+o+" "))r=r.replace(" "+o+" "," ");i!==(s=ht(r))&&n.setAttribute("class",s)}return this},toggleClass:function(i,t){var o=typeof i,a="string"===o||Array.isArray(i);return"boolean"==typeof t&&a?t?this.addClass(i):this.removeClass(i):m(i)?this.each(function(e){S(this).toggleClass(i.call(this,e,gt(this),t),t)}):this.each(function(){var e,t,n,r;if(a){t=0,n=S(this),r=vt(i);while(e=r[t++])n.hasClass(e)?n.removeClass(e):n.addClass(e)}else void 0!==i&&"boolean"!==o||((e=gt(this))&&Y.set(this,"__className__",e),this.setAttribute&&this.setAttribute("class",e||!1===i?"":Y.get(this,"__className__")||""))})},hasClass:function(e){var t,n,r=0;t=" "+e+" ";while(n=this[r++])if(1===n.nodeType&&-1<(" "+ht(gt(n))+" ").indexOf(t))return!0;return!1}});var yt=/\r/g;S.fn.extend({val:function(n){var r,e,i,t=this[0];return arguments.length?(i=m(n),this.each(function(e){var t;1===this.nodeType&&(null==(t=i?n.call(this,e,S(this).val()):n)?t="":"number"==typeof t?t+="":Array.isArray(t)&&(t=S.map(t,function(e){return null==e?"":e+""})),(r=S.valHooks[this.type]||S.valHooks[this.nodeName.toLowerCase()])&&"set"in r&&void 0!==r.set(this,t,"value")||(this.value=t))})):t?(r=S.valHooks[t.type]||S.valHooks[t.nodeName.toLowerCase()])&&"get"in r&&void 0!==(e=r.get(t,"value"))?e:"string"==typeof(e=t.value)?e.replace(yt,""):null==e?"":e:void 0}}),S.extend({valHooks:{option:{get:function(e){var t=S.find.attr(e,"value");return null!=t?t:ht(S.text(e))}},select:{get:function(e){var t,n,r,i=e.options,o=e.selectedIndex,a="select-one"===e.type,s=a?null:[],u=a?o+1:i.length;for(r=o<0?u:a?o:0;r<u;r++)if(((n=i[r]).selected||r===o)&&!n.disabled&&(!n.parentNode.disabled||!A(n.parentNode,"optgroup"))){if(t=S(n).val(),a)return t;s.push(t)}return s},set:function(e,t){var n,r,i=e.options,o=S.makeArray(t),a=i.length;while(a--)((r=i[a]).selected=-1<S.inArray(S.valHooks.option.get(r),o))&&(n=!0);return n||(e.selectedIndex=-1),o}}}}),S.each(["radio","checkbox"],function(){S.valHooks[this]={set:function(e,t){if(Array.isArray(t))return e.checked=-1<S.inArray(S(e).val(),t)}},y.checkOn||(S.valHooks[this].get=function(e){return null===e.getAttribute("value")?"on":e.value})}),y.focusin="onfocusin"in C;var mt=/^(?:focusinfocus|focusoutblur)$/,xt=function(e){e.stopPropagation()};S.extend(S.event,{trigger:function(e,t,n,r){var i,o,a,s,u,l,c,f,p=[n||E],d=v.call(e,"type")?e.type:e,h=v.call(e,"namespace")?e.namespace.split("."):[];if(o=f=a=n=n||E,3!==n.nodeType&&8!==n.nodeType&&!mt.test(d+S.event.triggered)&&(-1<d.indexOf(".")&&(d=(h=d.split(".")).shift(),h.sort()),u=d.indexOf(":")<0&&"on"+d,(e=e[S.expando]?e:new S.Event(d,"object"==typeof e&&e)).isTrigger=r?2:3,e.namespace=h.join("."),e.rnamespace=e.namespace?new RegExp("(^|\\.)"+h.join("\\.(?:.*\\.|)")+"(\\.|$)"):null,e.result=void 0,e.target||(e.target=n),t=null==t?[e]:S.makeArray(t,[e]),c=S.event.special[d]||{},r||!c.trigger||!1!==c.trigger.apply(n,t))){if(!r&&!c.noBubble&&!x(n)){for(s=c.delegateType||d,mt.test(s+d)||(o=o.parentNode);o;o=o.parentNode)p.push(o),a=o;a===(n.ownerDocument||E)&&p.push(a.defaultView||a.parentWindow||C)}i=0;while((o=p[i++])&&!e.isPropagationStopped())f=o,e.type=1<i?s:c.bindType||d,(l=(Y.get(o,"events")||Object.create(null))[e.type]&&Y.get(o,"handle"))&&l.apply(o,t),(l=u&&o[u])&&l.apply&&V(o)&&(e.result=l.apply(o,t),!1===e.result&&e.preventDefault());return e.type=d,r||e.isDefaultPrevented()||c._default&&!1!==c._default.apply(p.pop(),t)||!V(n)||u&&m(n[d])&&!x(n)&&((a=n[u])&&(n[u]=null),S.event.triggered=d,e.isPropagationStopped()&&f.addEventListener(d,xt),n[d](),e.isPropagationStopped()&&f.removeEventListener(d,xt),S.event.triggered=void 0,a&&(n[u]=a)),e.result}},simulate:function(e,t,n){var r=S.extend(new S.Event,n,{type:e,isSimulated:!0});S.event.trigger(r,null,t)}}),S.fn.extend({trigger:function(e,t){return this.each(function(){S.event.trigger(e,t,this)})},triggerHandler:function(e,t){var n=this[0];if(n)return S.event.trigger(e,t,n,!0)}}),y.focusin||S.each({focus:"focusin",blur:"focusout"},function(n,r){var i=function(e){S.event.simulate(r,e.target,S.event.fix(e))};S.event.special[r]={setup:function(){var e=this.ownerDocument||this.document||this,t=Y.access(e,r);t||e.addEventListener(n,i,!0),Y.access(e,r,(t||0)+1)},teardown:function(){var e=this.ownerDocument||this.document||this,t=Y.access(e,r)-1;t?Y.access(e,r,t):(e.removeEventListener(n,i,!0),Y.remove(e,r))}}});var bt=C.location,wt={guid:Date.now()},Tt=/\?/;S.parseXML=function(e){var t,n;if(!e||"string"!=typeof e)return null;try{t=(new C.DOMParser).parseFromString(e,"text/xml")}catch(e){}return n=t&&t.getElementsByTagName("parsererror")[0],t&&!n||S.error("Invalid XML: "+(n?S.map(n.childNodes,function(e){return e.textContent}).join("\n"):e)),t};var Ct=/\[\]$/,Et=/\r?\n/g,St=/^(?:submit|button|image|reset|file)$/i,kt=/^(?:input|select|textarea|keygen)/i;function At(n,e,r,i){var t;if(Array.isArray(e))S.each(e,function(e,t){r||Ct.test(n)?i(n,t):At(n+"["+("object"==typeof t&&null!=t?e:"")+"]",t,r,i)});else if(r||"object"!==w(e))i(n,e);else for(t in e)At(n+"["+t+"]",e[t],r,i)}S.param=function(e,t){var n,r=[],i=function(e,t){var n=m(t)?t():t;r[r.length]=encodeURIComponent(e)+"="+encodeURIComponent(null==n?"":n)};if(null==e)return"";if(Array.isArray(e)||e.jquery&&!S.isPlainObject(e))S.each(e,function(){i(this.name,this.value)});else for(n in e)At(n,e[n],t,i);return r.join("&")},S.fn.extend({serialize:function(){return S.param(this.serializeArray())},serializeArray:function(){return this.map(function(){var e=S.prop(this,"elements");return e?S.makeArray(e):this}).filter(function(){var e=this.type;return this.name&&!S(this).is(":disabled")&&kt.test(this.nodeName)&&!St.test(e)&&(this.checked||!pe.test(e))}).map(function(e,t){var n=S(this).val();return null==n?null:Array.isArray(n)?S.map(n,function(e){return{name:t.name,value:e.replace(Et,"\r\n")}}):{name:t.name,value:n.replace(Et,"\r\n")}}).get()}});var Nt=/%20/g,jt=/#.*$/,Dt=/([?&])_=[^&]*/,qt=/^(.*?):[ \t]*([^\r\n]*)$/gm,Lt=/^(?:GET|HEAD)$/,Ht=/^\/\//,Ot={},Pt={},Rt="*/".concat("*"),Mt=E.createElement("a");function It(o){return function(e,t){"string"!=typeof e&&(t=e,e="*");var n,r=0,i=e.toLowerCase().match(P)||[];if(m(t))while(n=i[r++])"+"===n[0]?(n=n.slice(1)||"*",(o[n]=o[n]||[]).unshift(t)):(o[n]=o[n]||[]).push(t)}}function Wt(t,i,o,a){var s={},u=t===Pt;function l(e){var r;return s[e]=!0,S.each(t[e]||[],function(e,t){var n=t(i,o,a);return"string"!=typeof n||u||s[n]?u?!(r=n):void 0:(i.dataTypes.unshift(n),l(n),!1)}),r}return l(i.dataTypes[0])||!s["*"]&&l("*")}function Ft(e,t){var n,r,i=S.ajaxSettings.flatOptions||{};for(n in t)void 0!==t[n]&&((i[n]?e:r||(r={}))[n]=t[n]);return r&&S.extend(!0,e,r),e}Mt.href=bt.href,S.extend({active:0,lastModified:{},etag:{},ajaxSettings:{url:bt.href,type:"GET",isLocal:/^(?:about|app|app-storage|.+-extension|file|res|widget):$/.test(bt.protocol),global:!0,processData:!0,async:!0,contentType:"application/x-www-form-urlencoded; charset=UTF-8",accepts:{"*":Rt,text:"text/plain",html:"text/html",xml:"application/xml, text/xml",json:"application/json, text/javascript"},contents:{xml:/\bxml\b/,html:/\bhtml/,json:/\bjson\b/},responseFields:{xml:"responseXML",text:"responseText",json:"responseJSON"},converters:{"* text":String,"text html":!0,"text json":JSON.parse,"text xml":S.parseXML},flatOptions:{url:!0,context:!0}},ajaxSetup:function(e,t){return t?Ft(Ft(e,S.ajaxSettings),t):Ft(S.ajaxSettings,e)},ajaxPrefilter:It(Ot),ajaxTransport:It(Pt),ajax:function(e,t){"object"==typeof e&&(t=e,e=void 0),t=t||{};var c,f,p,n,d,r,h,g,i,o,v=S.ajaxSetup({},t),y=v.context||v,m=v.context&&(y.nodeType||y.jquery)?S(y):S.event,x=S.Deferred(),b=S.Callbacks("once memory"),w=v.statusCode||{},a={},s={},u="canceled",T={readyState:0,getResponseHeader:function(e){var t;if(h){if(!n){n={};while(t=qt.exec(p))n[t[1].toLowerCase()+" "]=(n[t[1].toLowerCase()+" "]||[]).concat(t[2])}t=n[e.toLowerCase()+" "]}return null==t?null:t.join(", ")},getAllResponseHeaders:function(){return h?p:null},setRequestHeader:function(e,t){return null==h&&(e=s[e.toLowerCase()]=s[e.toLowerCase()]||e,a[e]=t),this},overrideMimeType:function(e){return null==h&&(v.mimeType=e),this},statusCode:function(e){var t;if(e)if(h)T.always(e[T.status]);else for(t in e)w[t]=[w[t],e[t]];return this},abort:function(e){var t=e||u;return c&&c.abort(t),l(0,t),this}};if(x.promise(T),v.url=((e||v.url||bt.href)+"").replace(Ht,bt.protocol+"//"),v.type=t.method||t.type||v.method||v.type,v.dataTypes=(v.dataType||"*").toLowerCase().match(P)||[""],null==v.crossDomain){r=E.createElement("a");try{r.href=v.url,r.href=r.href,v.crossDomain=Mt.protocol+"//"+Mt.host!=r.protocol+"//"+r.host}catch(e){v.crossDomain=!0}}if(v.data&&v.processData&&"string"!=typeof v.data&&(v.data=S.param(v.data,v.traditional)),Wt(Ot,v,t,T),h)return T;for(i in(g=S.event&&v.global)&&0==S.active++&&S.event.trigger("ajaxStart"),v.type=v.type.toUpperCase(),v.hasContent=!Lt.test(v.type),f=v.url.replace(jt,""),v.hasContent?v.data&&v.processData&&0===(v.contentType||"").indexOf("application/x-www-form-urlencoded")&&(v.data=v.data.replace(Nt,"+")):(o=v.url.slice(f.length),v.data&&(v.processData||"string"==typeof v.data)&&(f+=(Tt.test(f)?"&":"?")+v.data,delete v.data),!1===v.cache&&(f=f.replace(Dt,"$1"),o=(Tt.test(f)?"&":"?")+"_="+wt.guid+++o),v.url=f+o),v.ifModified&&(S.lastModified[f]&&T.setRequestHeader("If-Modified-Since",S.lastModified[f]),S.etag[f]&&T.setRequestHeader("If-None-Match",S.etag[f])),(v.data&&v.hasContent&&!1!==v.contentType||t.contentType)&&T.setRequestHeader("Content-Type",v.contentType),T.setRequestHeader("Accept",v.dataTypes[0]&&v.accepts[v.dataTypes[0]]?v.accepts[v.dataTypes[0]]+("*"!==v.dataTypes[0]?", "+Rt+"; q=0.01":""):v.accepts["*"]),v.headers)T.setRequestHeader(i,v.headers[i]);if(v.beforeSend&&(!1===v.beforeSend.call(y,T,v)||h))return T.abort();if(u="abort",b.add(v.complete),T.done(v.success),T.fail(v.error),c=Wt(Pt,v,t,T)){if(T.readyState=1,g&&m.trigger("ajaxSend",[T,v]),h)return T;v.async&&0<v.timeout&&(d=C.setTimeout(function(){T.abort("timeout")},v.timeout));try{h=!1,c.send(a,l)}catch(e){if(h)throw e;l(-1,e)}}else l(-1,"No Transport");function l(e,t,n,r){var i,o,a,s,u,l=t;h||(h=!0,d&&C.clearTimeout(d),c=void 0,p=r||"",T.readyState=0<e?4:0,i=200<=e&&e<300||304===e,n&&(s=function(e,t,n){var r,i,o,a,s=e.contents,u=e.dataTypes;while("*"===u[0])u.shift(),void 0===r&&(r=e.mimeType||t.getResponseHeader("Content-Type"));if(r)for(i in s)if(s[i]&&s[i].test(r)){u.unshift(i);break}if(u[0]in n)o=u[0];else{for(i in n){if(!u[0]||e.converters[i+" "+u[0]]){o=i;break}a||(a=i)}o=o||a}if(o)return o!==u[0]&&u.unshift(o),n[o]}(v,T,n)),!i&&-1<S.inArray("script",v.dataTypes)&&S.inArray("json",v.dataTypes)<0&&(v.converters["text script"]=function(){}),s=function(e,t,n,r){var i,o,a,s,u,l={},c=e.dataTypes.slice();if(c[1])for(a in e.converters)l[a.toLowerCase()]=e.converters[a];o=c.shift();while(o)if(e.responseFields[o]&&(n[e.responseFields[o]]=t),!u&&r&&e.dataFilter&&(t=e.dataFilter(t,e.dataType)),u=o,o=c.shift())if("*"===o)o=u;else if("*"!==u&&u!==o){if(!(a=l[u+" "+o]||l["* "+o]))for(i in l)if((s=i.split(" "))[1]===o&&(a=l[u+" "+s[0]]||l["* "+s[0]])){!0===a?a=l[i]:!0!==l[i]&&(o=s[0],c.unshift(s[1]));break}if(!0!==a)if(a&&e["throws"])t=a(t);else try{t=a(t)}catch(e){return{state:"parsererror",error:a?e:"No conversion from "+u+" to "+o}}}return{state:"success",data:t}}(v,s,T,i),i?(v.ifModified&&((u=T.getResponseHeader("Last-Modified"))&&(S.lastModified[f]=u),(u=T.getResponseHeader("etag"))&&(S.etag[f]=u)),204===e||"HEAD"===v.type?l="nocontent":304===e?l="notmodified":(l=s.state,o=s.data,i=!(a=s.error))):(a=l,!e&&l||(l="error",e<0&&(e=0))),T.status=e,T.statusText=(t||l)+"",i?x.resolveWith(y,[o,l,T]):x.rejectWith(y,[T,l,a]),T.statusCode(w),w=void 0,g&&m.trigger(i?"ajaxSuccess":"ajaxError",[T,v,i?o:a]),b.fireWith(y,[T,l]),g&&(m.trigger("ajaxComplete",[T,v]),--S.active||S.event.trigger("ajaxStop")))}return T},getJSON:function(e,t,n){return S.get(e,t,n,"json")},getScript:function(e,t){return S.get(e,void 0,t,"script")}}),S.each(["get","post"],function(e,i){S[i]=function(e,t,n,r){return m(t)&&(r=r||n,n=t,t=void 0),S.ajax(S.extend({url:e,type:i,dataType:r,data:t,success:n},S.isPlainObject(e)&&e))}}),S.ajaxPrefilter(function(e){var t;for(t in e.headers)"content-type"===t.toLowerCase()&&(e.contentType=e.headers[t]||"")}),S._evalUrl=function(e,t,n){return S.ajax({url:e,type:"GET",dataType:"script",cache:!0,async:!1,global:!1,converters:{"text script":function(){}},dataFilter:function(e){S.globalEval(e,t,n)}})},S.fn.extend({wrapAll:function(e){var t;return this[0]&&(m(e)&&(e=e.call(this[0])),t=S(e,this[0].ownerDocument).eq(0).clone(!0),this[0].parentNode&&t.insertBefore(this[0]),t.map(function(){var e=this;while(e.firstElementChild)e=e.firstElementChild;return e}).append(this)),this},wrapInner:function(n){return m(n)?this.each(function(e){S(this).wrapInner(n.call(this,e))}):this.each(function(){var e=S(this),t=e.contents();t.length?t.wrapAll(n):e.append(n)})},wrap:function(t){var n=m(t);return this.each(function(e){S(this).wrapAll(n?t.call(this,e):t)})},unwrap:function(e){return this.parent(e).not("body").each(function(){S(this).replaceWith(this.childNodes)}),this}}),S.expr.pseudos.hidden=function(e){return!S.expr.pseudos.visible(e)},S.expr.pseudos.visible=function(e){return!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)},S.ajaxSettings.xhr=function(){try{return new C.XMLHttpRequest}catch(e){}};var Bt={0:200,1223:204},$t=S.ajaxSettings.xhr();y.cors=!!$t&&"withCredentials"in $t,y.ajax=$t=!!$t,S.ajaxTransport(function(i){var o,a;if(y.cors||$t&&!i.crossDomain)return{send:function(e,t){var n,r=i.xhr();if(r.open(i.type,i.url,i.async,i.username,i.password),i.xhrFields)for(n in i.xhrFields)r[n]=i.xhrFields[n];for(n in i.mimeType&&r.overrideMimeType&&r.overrideMimeType(i.mimeType),i.crossDomain||e["X-Requested-With"]||(e["X-Requested-With"]="XMLHttpRequest"),e)r.setRequestHeader(n,e[n]);o=function(e){return function(){o&&(o=a=r.onload=r.onerror=r.onabort=r.ontimeout=r.onreadystatechange=null,"abort"===e?r.abort():"error"===e?"number"!=typeof r.status?t(0,"error"):t(r.status,r.statusText):t(Bt[r.status]||r.status,r.statusText,"text"!==(r.responseType||"text")||"string"!=typeof r.responseText?{binary:r.response}:{text:r.responseText},r.getAllResponseHeaders()))}},r.onload=o(),a=r.onerror=r.ontimeout=o("error"),void 0!==r.onabort?r.onabort=a:r.onreadystatechange=function(){4===r.readyState&&C.setTimeout(function(){o&&a()})},o=o("abort");try{r.send(i.hasContent&&i.data||null)}catch(e){if(o)throw e}},abort:function(){o&&o()}}}),S.ajaxPrefilter(function(e){e.crossDomain&&(e.contents.script=!1)}),S.ajaxSetup({accepts:{script:"text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},contents:{script:/\b(?:java|ecma)script\b/},converters:{"text script":function(e){return S.globalEval(e),e}}}),S.ajaxPrefilter("script",function(e){void 0===e.cache&&(e.cache=!1),e.crossDomain&&(e.type="GET")}),S.ajaxTransport("script",function(n){var r,i;if(n.crossDomain||n.scriptAttrs)return{send:function(e,t){r=S("<script>").attr(n.scriptAttrs||{}).prop({charset:n.scriptCharset,src:n.url}).on("load error",i=function(e){r.remove(),i=null,e&&t("error"===e.type?404:200,e.type)}),E.head.appendChild(r[0])},abort:function(){i&&i()}}});var _t,zt=[],Ut=/(=)\?(?=&|$)|\?\?/;S.ajaxSetup({jsonp:"callback",jsonpCallback:function(){var e=zt.pop()||S.expando+"_"+wt.guid++;return this[e]=!0,e}}),S.ajaxPrefilter("json jsonp",function(e,t,n){var r,i,o,a=!1!==e.jsonp&&(Ut.test(e.url)?"url":"string"==typeof e.data&&0===(e.contentType||"").indexOf("application/x-www-form-urlencoded")&&Ut.test(e.data)&&"data");if(a||"jsonp"===e.dataTypes[0])return r=e.jsonpCallback=m(e.jsonpCallback)?e.jsonpCallback():e.jsonpCallback,a?e[a]=e[a].replace(Ut,"$1"+r):!1!==e.jsonp&&(e.url+=(Tt.test(e.url)?"&":"?")+e.jsonp+"="+r),e.converters["script json"]=function(){return o||S.error(r+" was not called"),o[0]},e.dataTypes[0]="json",i=C[r],C[r]=function(){o=arguments},n.always(function(){void 0===i?S(C).removeProp(r):C[r]=i,e[r]&&(e.jsonpCallback=t.jsonpCallback,zt.push(r)),o&&m(i)&&i(o[0]),o=i=void 0}),"script"}),y.createHTMLDocument=((_t=E.implementation.createHTMLDocument("").body).innerHTML="<form></form><form></form>",2===_t.childNodes.length),S.parseHTML=function(e,t,n){return"string"!=typeof e?[]:("boolean"==typeof t&&(n=t,t=!1),t||(y.createHTMLDocument?((r=(t=E.implementation.createHTMLDocument("")).createElement("base")).href=E.location.href,t.head.appendChild(r)):t=E),o=!n&&[],(i=N.exec(e))?[t.createElement(i[1])]:(i=xe([e],t,o),o&&o.length&&S(o).remove(),S.merge([],i.childNodes)));var r,i,o},S.fn.load=function(e,t,n){var r,i,o,a=this,s=e.indexOf(" ");return-1<s&&(r=ht(e.slice(s)),e=e.slice(0,s)),m(t)?(n=t,t=void 0):t&&"object"==typeof t&&(i="POST"),0<a.length&&S.ajax({url:e,type:i||"GET",dataType:"html",data:t}).done(function(e){o=arguments,a.html(r?S("<div>").append(S.parseHTML(e)).find(r):e)}).always(n&&function(e,t){a.each(function(){n.apply(this,o||[e.responseText,t,e])})}),this},S.expr.pseudos.animated=function(t){return S.grep(S.timers,function(e){return t===e.elem}).length},S.offset={setOffset:function(e,t,n){var r,i,o,a,s,u,l=S.css(e,"position"),c=S(e),f={};"static"===l&&(e.style.position="relative"),s=c.offset(),o=S.css(e,"top"),u=S.css(e,"left"),("absolute"===l||"fixed"===l)&&-1<(o+u).indexOf("auto")?(a=(r=c.position()).top,i=r.left):(a=parseFloat(o)||0,i=parseFloat(u)||0),m(t)&&(t=t.call(e,n,S.extend({},s))),null!=t.top&&(f.top=t.top-s.top+a),null!=t.left&&(f.left=t.left-s.left+i),"using"in t?t.using.call(e,f):c.css(f)}},S.fn.extend({offset:function(t){if(arguments.length)return void 0===t?this:this.each(function(e){S.offset.setOffset(this,t,e)});var e,n,r=this[0];return r?r.getClientRects().length?(e=r.getBoundingClientRect(),n=r.ownerDocument.defaultView,{top:e.top+n.pageYOffset,left:e.left+n.pageXOffset}):{top:0,left:0}:void 0},position:function(){if(this[0]){var e,t,n,r=this[0],i={top:0,left:0};if("fixed"===S.css(r,"position"))t=r.getBoundingClientRect();else{t=this.offset(),n=r.ownerDocument,e=r.offsetParent||n.documentElement;while(e&&(e===n.body||e===n.documentElement)&&"static"===S.css(e,"position"))e=e.parentNode;e&&e!==r&&1===e.nodeType&&((i=S(e).offset()).top+=S.css(e,"borderTopWidth",!0),i.left+=S.css(e,"borderLeftWidth",!0))}return{top:t.top-i.top-S.css(r,"marginTop",!0),left:t.left-i.left-S.css(r,"marginLeft",!0)}}},offsetParent:function(){return this.map(function(){var e=this.offsetParent;while(e&&"static"===S.css(e,"position"))e=e.offsetParent;return e||re})}}),S.each({scrollLeft:"pageXOffset",scrollTop:"pageYOffset"},function(t,i){var o="pageYOffset"===i;S.fn[t]=function(e){return $(this,function(e,t,n){var r;if(x(e)?r=e:9===e.nodeType&&(r=e.defaultView),void 0===n)return r?r[i]:e[t];r?r.scrollTo(o?r.pageXOffset:n,o?n:r.pageYOffset):e[t]=n},t,e,arguments.length)}}),S.each(["top","left"],function(e,n){S.cssHooks[n]=Fe(y.pixelPosition,function(e,t){if(t)return t=We(e,n),Pe.test(t)?S(e).position()[n]+"px":t})}),S.each({Height:"height",Width:"width"},function(a,s){S.each({padding:"inner"+a,content:s,"":"outer"+a},function(r,o){S.fn[o]=function(e,t){var n=arguments.length&&(r||"boolean"!=typeof e),i=r||(!0===e||!0===t?"margin":"border");return $(this,function(e,t,n){var r;return x(e)?0===o.indexOf("outer")?e["inner"+a]:e.document.documentElement["client"+a]:9===e.nodeType?(r=e.documentElement,Math.max(e.body["scroll"+a],r["scroll"+a],e.body["offset"+a],r["offset"+a],r["client"+a])):void 0===n?S.css(e,t,i):S.style(e,t,n,i)},s,n?e:void 0,n)}})}),S.each(["ajaxStart","ajaxStop","ajaxComplete","ajaxError","ajaxSuccess","ajaxSend"],function(e,t){S.fn[t]=function(e){return this.on(t,e)}}),S.fn.extend({bind:function(e,t,n){return this.on(e,null,t,n)},unbind:function(e,t){return this.off(e,null,t)},delegate:function(e,t,n,r){return this.on(t,e,n,r)},undelegate:function(e,t,n){return 1===arguments.length?this.off(e,"**"):this.off(t,e||"**",n)},hover:function(e,t){return this.mouseenter(e).mouseleave(t||e)}}),S.each("blur focus focusin focusout resize scroll click dblclick mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave change select submit keydown keypress keyup contextmenu".split(" "),function(e,n){S.fn[n]=function(e,t){return 0<arguments.length?this.on(n,null,e,t):this.trigger(n)}});var Xt=/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g;S.proxy=function(e,t){var n,r,i;if("string"==typeof t&&(n=e[t],t=e,e=n),m(e))return r=s.call(arguments,2),(i=function(){return e.apply(t||this,r.concat(s.call(arguments)))}).guid=e.guid=e.guid||S.guid++,i},S.holdReady=function(e){e?S.readyWait++:S.ready(!0)},S.isArray=Array.isArray,S.parseJSON=JSON.parse,S.nodeName=A,S.isFunction=m,S.isWindow=x,S.camelCase=X,S.type=w,S.now=Date.now,S.isNumeric=function(e){var t=S.type(e);return("number"===t||"string"===t)&&!isNaN(e-parseFloat(e))},S.trim=function(e){return null==e?"":(e+"").replace(Xt,"")},"function"==typeof define&&define.amd&&define("jquery",[],function(){return S});var Vt=C.jQuery,Gt=C.$;return S.noConflict=function(e){return C.$===S&&(C.$=Gt),e&&C.jQuery===S&&(C.jQuery=Vt),S},"undefined"==typeof e&&(C.jQuery=C.$=S),S});
Opal.loaded(["./jquery-3.6.0.min.js"]);
Opal.modules["native"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $defs = Opal.defs, $truthy = Opal.truthy, $send = Opal.send, $Kernel = Opal.Kernel, $hash2 = Opal.hash2, $range = Opal.range, $to_a = Opal.to_a, $def = Opal.def, $return_ivar = Opal.return_ivar, $alias = Opal.alias, $klass = Opal.klass, $rb_minus = Opal.rb_minus, $return_val = Opal.return_val, $send2 = Opal.send2, $find_super = Opal.find_super, $eqeqeq = Opal.eqeqeq, $rb_ge = Opal.rb_ge, $return_self = Opal.return_self, $gvars = Opal.gvars;

  Opal.add_stubs('try_convert,native?,respond_to?,to_n,raise,inspect,Native,proc,map!,end_with?,define_method,[],convert,call,to_proc,new,each,native_reader,native_writer,extend,warn,include,is_a?,map,Array,to_a,_Array,method_missing,bind,instance_method,[]=,slice,-,length,has_key?,enum_for,===,>=,<<,each_pair,method_defined?,initialize,_initialize,name,native_module');
  
  (function($base, $parent_nesting) {
    var self = $module($base, 'Native');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    $defs(self, '$is_a?', function $Native_is_a$ques$1(object, klass) {
      var self = this;

      
      try {
        return object instanceof self.$try_convert(klass);
      }
      catch (e) {
        return false;
      }
    
    }, 2);
    $defs(self, '$try_convert', function $$try_convert(value, default$) {
      var self = this;

      
      
      if (default$ == null) default$ = nil;;
      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        return default$;
      }
    ;
    }, -2);
    $defs(self, '$convert', function $$convert(value) {
      var self = this;

      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        self.$raise($$('ArgumentError'), "" + (value.$inspect()) + " isn't native");
      }
    
    }, 1);
    $defs(self, '$call', function $$call(obj, key, $a) {
      var block = $$call.$$p || nil, $post_args, args, self = this;

      delete $$call.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 2);
      
      args = $post_args;;
      
      var prop = obj[key];

      if (prop instanceof Function) {
        var converted = new Array(args.length);

        for (var i = 0, l = args.length; i < l; i++) {
          var item = args[i],
              conv = self.$try_convert(item);

          converted[i] = conv === nil ? item : conv;
        }

        if (block !== nil) {
          converted.push(block);
        }

        return self.$Native(prop.apply(obj, converted));
      }
      else {
        return self.$Native(prop);
      }
    ;
    }, -3);
    $defs(self, '$proc', function $$proc() {
      var block = $$proc.$$p || nil, self = this;

      delete $$proc.$$p;
      
      ;
      if (!$truthy(block)) {
        self.$raise($$('LocalJumpError'), "no block given")
      };
      return $send($Kernel, 'proc', [], function $$2($a){var $post_args, args, self = $$2.$$s == null ? this : $$2.$$s, instance = nil;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        $send(args, 'map!', [], function $$3(arg){var self = $$3.$$s == null ? this : $$3.$$s;

          
          
          if (arg == null) arg = nil;;
          return self.$Native(arg);}, {$$arity: 1, $$s: self});
        instance = self.$Native(this);
        
        // if global is current scope, run the block in the scope it was defined
        if (this === Opal.global) {
          return block.apply(self, args);
        }

        var self_ = block.$$s;
        block.$$s = null;

        try {
          return block.apply(instance, args);
        }
        finally {
          block.$$s = self_;
        }
      ;}, {$$arity: -1, $$s: self});
    }, 0);
    (function($base, $parent_nesting) {
      var self = $module($base, 'Helpers');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      
      $def(self, '$alias_native', function $$alias_native(new$, $a, $b) {
        var $post_args, $kwargs, old, as, $yield = $$alias_native.$$p || nil, self = this;

        delete $$alias_native.$$p;
        
        
        $post_args = Opal.slice.call(arguments, 1);
        
        $kwargs = Opal.extract_kwargs($post_args);
        
        if ($kwargs == null) {
          $kwargs = $hash2([], {});
        } else if (!$kwargs.$$is_hash) {
          throw Opal.ArgumentError.$new('expected kwargs');
        };
        
        if ($post_args.length > 0) old = $post_args.shift();
        if (old == null) old = new$;;
        
        as = $kwargs.$$smap["as"];
        if (as == null) as = nil;
        if ($truthy(old['$end_with?']("="))) {
          return $send(self, 'define_method', [new$], function $$4(value){var self = $$4.$$s == null ? this : $$4.$$s;
            if (self["native"] == null) self["native"] = nil;

            
            
            if (value == null) value = nil;;
            self["native"][old['$[]']($range(0, -2, false))] = $$('Native').$convert(value);
            return value;}, {$$arity: 1, $$s: self})
        } else if ($truthy(as)) {
          return $send(self, 'define_method', [new$], function $$5($c){var block = $$5.$$p || nil, $post_args, args, self = $$5.$$s == null ? this : $$5.$$s, value = nil;
            if (self["native"] == null) self["native"] = nil;

            delete $$5.$$p;
            
            ;
            
            $post_args = Opal.slice.call(arguments);
            
            args = $post_args;;
            value = $send($$('Native'), 'call', [self["native"], old].concat($to_a(args)), block.$to_proc());
            if ($truthy(value)) {
              return as.$new(value.$to_n())
            } else {
              return nil
            };}, {$$arity: -1, $$s: self})
        } else {
          return $send(self, 'define_method', [new$], function $$6($c){var block = $$6.$$p || nil, $post_args, args, self = $$6.$$s == null ? this : $$6.$$s;
            if (self["native"] == null) self["native"] = nil;

            delete $$6.$$p;
            
            ;
            
            $post_args = Opal.slice.call(arguments);
            
            args = $post_args;;
            return $send($$('Native'), 'call', [self["native"], old].concat($to_a(args)), block.$to_proc());}, {$$arity: -1, $$s: self})
        };
      }, -2);
      
      $def(self, '$native_reader', function $$native_reader($a) {
        var $post_args, names, self = this;

        
        
        $post_args = Opal.slice.call(arguments);
        
        names = $post_args;;
        return $send(names, 'each', [], function $$7(name){var self = $$7.$$s == null ? this : $$7.$$s;

          
          
          if (name == null) name = nil;;
          return $send(self, 'define_method', [name], function $$8(){var self = $$8.$$s == null ? this : $$8.$$s;
            if (self["native"] == null) self["native"] = nil;

            return self.$Native(self["native"][name])}, {$$arity: 0, $$s: self});}, {$$arity: 1, $$s: self});
      }, -1);
      
      $def(self, '$native_writer', function $$native_writer($a) {
        var $post_args, names, self = this;

        
        
        $post_args = Opal.slice.call(arguments);
        
        names = $post_args;;
        return $send(names, 'each', [], function $$9(name){var self = $$9.$$s == null ? this : $$9.$$s;

          
          
          if (name == null) name = nil;;
          return $send(self, 'define_method', ["" + (name) + "="], function $$10(value){var self = $$10.$$s == null ? this : $$10.$$s;
            if (self["native"] == null) self["native"] = nil;

            
            
            if (value == null) value = nil;;
            return self.$Native(self["native"][name] = value);}, {$$arity: 1, $$s: self});}, {$$arity: 1, $$s: self});
      }, -1);
      return $def(self, '$native_accessor', function $$native_accessor($a) {
        var $post_args, names, self = this;

        
        
        $post_args = Opal.slice.call(arguments);
        
        names = $post_args;;
        $send(self, 'native_reader', $to_a(names));
        return $send(self, 'native_writer', $to_a(names));
      }, -1);
    })($nesting[0], $nesting);
    (function($base, $parent_nesting) {
      var self = $module($base, 'Wrapper');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      
      $def(self, '$initialize', function $$initialize(native$) {
        var self = this;

        
        if (!$truthy($Kernel['$native?'](native$))) {
          $Kernel.$raise($$('ArgumentError'), "" + (native$.$inspect()) + " isn't native")
        };
        return (self["native"] = native$);
      }, 1);
      
      $def(self, '$to_n', $return_ivar("native"), 0);
      return $defs(self, '$included', function $$included(klass) {
        
        return klass.$extend($$('Helpers'))
      }, 1);
    })($nesting[0], $nesting);
    return $defs(self, '$included', function $$included(base) {
      var self = this;

      
      self.$warn("Including ::Native is deprecated. Please include Native::Wrapper instead.");
      return base.$include($$('Wrapper'));
    }, 1);
  })($nesting[0], $nesting);
  (function($base, $parent_nesting) {
    var self = $module($base, 'Kernel');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    
    $def(self, '$native?', function $Kernel_native$ques$11(value) {
      
      return value == null || !value.$$class;
    }, 1);
    
    $def(self, '$Native', function $$Native(obj) {
      var $yield = $$Native.$$p || nil, self = this;

      delete $$Native.$$p;
      if ($truthy(obj == null)) {
        return nil
      } else if ($truthy(self['$native?'](obj))) {
        return $$$($$('Native'), 'Object').$new(obj)
      } else if ($truthy(obj['$is_a?']($$('Array')))) {
        return $send(obj, 'map', [], function $$12(o){var self = $$12.$$s == null ? this : $$12.$$s;

          
          
          if (o == null) o = nil;;
          return self.$Native(o);}, {$$arity: 1, $$s: self})
      } else if ($truthy(obj['$is_a?']($$('Proc')))) {
        return $send(self, 'proc', [], function $$13($a){var block = $$13.$$p || nil, $post_args, args, self = $$13.$$s == null ? this : $$13.$$s;

          delete $$13.$$p;
          
          ;
          
          $post_args = Opal.slice.call(arguments);
          
          args = $post_args;;
          return self.$Native($send(obj, 'call', $to_a(args), block.$to_proc()));}, {$$arity: -1, $$s: self})
      } else {
        return obj
      }
    }, 1);
    $alias(self, "_Array", "Array");
    return $def(self, '$Array', function $$Array(object, $a) {
      var block = $$Array.$$p || nil, $post_args, args, self = this;

      delete $$Array.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      if ($truthy(self['$native?'](object))) {
        return $send($$$($$('Native'), 'Array'), 'new', [object].concat($to_a(args)), block.$to_proc()).$to_a()
      };
      return self.$_Array(object);
    }, -2);
  })($nesting[0], $nesting);
  (function($base, $super) {
    var self = $klass($base, $super, 'Object');

    var $proto = self.$$prototype;

    $proto["native"] = nil;
    
    self.$include($$$($$$('Native'), 'Wrapper'));
    
    $def(self, '$==', function $Object_$eq_eq$14(other) {
      var self = this;

      return self["native"] === $$$('Native').$try_convert(other)
    }, 1);
    
    $def(self, '$has_key?', function $Object_has_key$ques$15(name) {
      var self = this;

      return Opal.hasOwnProperty.call(self["native"], name)
    }, 1);
    
    $def(self, '$each', function $$each($a) {
      var $post_args, args, $yield = $$each.$$p || nil, self = this;

      delete $$each.$$p;
      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      if (($yield !== nil)) {
        
        
        for (var key in self["native"]) {
          Opal.yieldX($yield, [key, self["native"][key]])
        }
      ;
        return self;
      } else {
        return $send(self, 'method_missing', ["each"].concat($to_a(args)))
      };
    }, -1);
    
    $def(self, '$[]', function $Object_$$$16(key) {
      var self = this;

      
      var prop = self["native"][key];

      if (prop instanceof Function) {
        return prop;
      }
      else {
        return $$$('Native').$call(self["native"], key)
      }
    
    }, 1);
    
    $def(self, '$[]=', function $Object_$$$eq$17(key, value) {
      var self = this, native$ = nil;

      
      native$ = $$$('Native').$try_convert(value);
      if ($truthy(native$ === nil)) {
        return self["native"][key] = value
      } else {
        return self["native"][key] = native$
      };
    }, 2);
    
    $def(self, '$merge!', function $Object_merge$excl$18(other) {
      var self = this;

      
      
      other = $$$('Native').$convert(other);

      for (var prop in other) {
        self["native"][prop] = other[prop];
      }
    ;
      return self;
    }, 1);
    
    $def(self, '$respond_to?', function $Object_respond_to$ques$19(name, include_all) {
      var self = this;

      
      
      if (include_all == null) include_all = false;;
      return $Kernel.$instance_method("respond_to?").$bind(self).$call(name, include_all);
    }, -2);
    
    $def(self, '$respond_to_missing?', function $Object_respond_to_missing$ques$20(name, include_all) {
      var self = this;

      
      
      if (include_all == null) include_all = false;;
      return Opal.hasOwnProperty.call(self["native"], name);
    }, -2);
    
    $def(self, '$method_missing', function $$method_missing(mid, $a) {
      var block = $$method_missing.$$p || nil, $post_args, args, $b, self = this;

      delete $$method_missing.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      
      if (mid.charAt(mid.length - 1) === '=') {
        return ($b = [mid.$slice(0, $rb_minus(mid.$length(), 1)), args['$[]'](0)], $send(self, '[]=', $b), $b[$b.length - 1]);
      }
      else {
        return $send($$$('Native'), 'call', [self["native"], mid].concat($to_a(args)), block.$to_proc());
      }
    ;
    }, -2);
    
    $def(self, '$nil?', $return_val(false), 0);
    
    $def(self, '$is_a?', function $Object_is_a$ques$21(klass) {
      var self = this;

      return Opal.is_a(self, klass);
    }, 1);
    
    $def(self, '$instance_of?', function $Object_instance_of$ques$22(klass) {
      var self = this;

      return self.$$class === klass;
    }, 1);
    
    $def(self, '$class', function $Object_class$23() {
      var self = this;

      return self.$$class;
    }, 0);
    
    $def(self, '$to_a', function $$to_a(options) {
      var block = $$to_a.$$p || nil, self = this;

      delete $$to_a.$$p;
      
      ;
      
      if (options == null) options = $hash2([], {});;
      return $send($$$($$$('Native'), 'Array'), 'new', [self["native"], options], block.$to_proc()).$to_a();
    }, -1);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      return "#<Native:" + (String(self["native"])) + ">"
    }, 0);
    $alias(self, "include?", "has_key?");
    $alias(self, "key?", "has_key?");
    $alias(self, "kind_of?", "is_a?");
    return $alias(self, "member?", "has_key?");
  })($$('Native'), $$('BasicObject'));
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Array');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.named = $proto["native"] = $proto.get = $proto.block = $proto.set = $proto.length = nil;
    
    self.$include($$$($$('Native'), 'Wrapper'));
    self.$include($$('Enumerable'));
    
    $def(self, '$initialize', function $$initialize(native$, options) {
      var block = $$initialize.$$p || nil, self = this, $ret_or_1 = nil;

      delete $$initialize.$$p;
      
      ;
      
      if (options == null) options = $hash2([], {});;
      $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', [native$], null);
      self.get = ($truthy(($ret_or_1 = options['$[]']("get"))) ? ($ret_or_1) : (options['$[]']("access")));
      self.named = options['$[]']("named");
      self.set = ($truthy(($ret_or_1 = options['$[]']("set"))) ? ($ret_or_1) : (options['$[]']("access")));
      self.length = ($truthy(($ret_or_1 = options['$[]']("length"))) ? ($ret_or_1) : ("length"));
      self.block = block;
      if ($truthy(self.$length() == null)) {
        return self.$raise($$('ArgumentError'), "no length found on the array-like object")
      } else {
        return nil
      };
    }, -2);
    
    $def(self, '$each', function $$each() {
      var block = $$each.$$p || nil, self = this;

      delete $$each.$$p;
      
      ;
      if (!$truthy(block)) {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.$length(); i < length; i++) {
        Opal.yield1(block, self['$[]'](i));
      }
    ;
      return self;
    }, 0);
    
    $def(self, '$[]', function $Array_$$$24(index) {
      var self = this, result = nil, $ret_or_1 = nil;

      
      result = (($eqeqeq($$('String'), ($ret_or_1 = index)) || ($eqeqeq($$('Symbol'), $ret_or_1))) ? (($truthy(self.named) ? (self["native"][self.named](index)) : (self["native"][index]))) : ($eqeqeq($$('Integer'), $ret_or_1) ? (($truthy(self.get) ? (self["native"][self.get](index)) : (self["native"][index]))) : (nil)));
      if ($truthy(result)) {
        if ($truthy(self.block)) {
          return self.block.$call(result)
        } else {
          return self.$Native(result)
        }
      } else {
        return nil
      };
    }, 1);
    
    $def(self, '$[]=', function $Array_$$$eq$25(index, value) {
      var self = this;

      if ($truthy(self.set)) {
        return self["native"][self.set](index, $$('Native').$convert(value))
      } else {
        return self["native"][index] = $$('Native').$convert(value)
      }
    }, 2);
    
    $def(self, '$last', function $$last(count) {
      var $a, self = this, index = nil, result = nil;

      
      
      if (count == null) count = nil;;
      if ($truthy(count)) {
        
        index = $rb_minus(self.$length(), 1);
        result = [];
        while ($truthy($rb_ge(index, 0))) {
          
          result['$<<'](self['$[]'](index));
          index = $rb_minus(index, 1);
        };
        return result;
      } else {
        return self['$[]']($rb_minus(self.$length(), 1))
      };
    }, -1);
    
    $def(self, '$length', function $$length() {
      var self = this;

      return self["native"][self.length]
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      return self.$to_a().$inspect()
    }, 0);
    return $alias(self, "to_ary", "to_a");
  })($$('Native'), null, $nesting);
  (function($base, $super) {
    var self = $klass($base, $super, 'Numeric');

    
    return $def(self, '$to_n', function $$to_n() {
      var self = this;

      return self.valueOf();
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'Proc');

    
    return $def(self, '$to_n', $return_self, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'String');

    
    return $def(self, '$to_n', function $$to_n() {
      var self = this;

      return self.valueOf();
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'Regexp');

    
    return $def(self, '$to_n', function $$to_n() {
      var self = this;

      return self.valueOf();
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'MatchData');

    
    return $def(self, '$to_n', $return_ivar("matches"), 0)
  })($nesting[0], null);
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Struct');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    return $def(self, '$to_n', function $$to_n() {
      var self = this, result = nil;

      
      result = {};
      $send(self, 'each_pair', [], function $$26(name, value){
        
        
        if (name == null) name = nil;;
        
        if (value == null) value = nil;;
        return result[name] = $$('Native').$try_convert(value, value);}, 2);
      return result;
    }, 0)
  })($nesting[0], null, $nesting);
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Array');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    return $def(self, '$to_n', function $$to_n() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var obj = self[i];

        result.push($$('Native').$try_convert(obj, obj));
      }

      return result;
    
    }, 0)
  })($nesting[0], null, $nesting);
  (function($base, $super) {
    var self = $klass($base, $super, 'Boolean');

    
    return $def(self, '$to_n', function $$to_n() {
      var self = this;

      return self.valueOf();
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'Time');

    
    return $def(self, '$to_n', $return_self, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'NilClass');

    
    return $def(self, '$to_n', function $$to_n() {
      
      return null;
    }, 0)
  })($nesting[0], null);
  if (!$truthy($$('Hash')['$method_defined?']("_initialize"))) {
    (function($base, $super, $parent_nesting) {
      var self = $klass($base, $super, 'Hash');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      $alias(self, "_initialize", "initialize");
      
      $def(self, '$initialize', function $$initialize(defaults) {
        var block = $$initialize.$$p || nil, self = this;

        delete $$initialize.$$p;
        
        ;
        ;
        
        if (defaults != null &&
             (defaults.constructor === undefined ||
               defaults.constructor === Object)) {
          var smap = self.$$smap,
              keys = self.$$keys,
              key, value;

          for (key in defaults) {
            value = defaults[key];

            if (value &&
                 (value.constructor === undefined ||
                   value.constructor === Object)) {
              smap[key] = $$('Hash').$new(value);
            } else if (value && value.$$is_array) {
              value = value.map(function(item) {
                if (item &&
                     (item.constructor === undefined ||
                       item.constructor === Object)) {
                  return $$('Hash').$new(item);
                }

                return self.$Native(item);
              });
              smap[key] = value
            } else {
              smap[key] = self.$Native(value);
            }

            keys.push(key);
          }

          return self;
        }

        return $send(self, '_initialize', [defaults], block.$to_proc());
      ;
      }, -1);
      return $def(self, '$to_n', function $$to_n() {
        var self = this;

        
        var result = {},
            keys = self.$$keys,
            smap = self.$$smap,
            key, value;

        for (var i = 0, length = keys.length; i < length; i++) {
          key = keys[i];

          if (key.$$is_string) {
            value = smap[key];
          } else {
            key = key.key;
            value = key.value;
          }

          result[key] = $$('Native').$try_convert(value, value);
        }

        return result;
      
      }, 0);
    })($nesting[0], null, $nesting)
  };
  (function($base, $super) {
    var self = $klass($base, $super, 'Module');

    
    return $def(self, '$native_module', function $$native_module() {
      var self = this;

      return Opal.global[self.$name()] = self
    }, 0)
  })($nesting[0], null);
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Class');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    
    $def(self, '$native_alias', function $$native_alias(new_jsid, existing_mid) {
      var self = this;

      
      var aliased = self.prototype['$' + existing_mid];
      if (!aliased) {
        self.$raise($$('NameError').$new("undefined method `" + (existing_mid) + "' for class `" + (self.$inspect()) + "'", existing_mid));
      }
      self.prototype[new_jsid] = aliased;
    
    }, 2);
    return $def(self, '$native_class', function $$native_class() {
      var self = this;

      
      self.$native_module();
      return self["new"] = self.$new;;
    }, 0);
  })($nesting[0], null, $nesting);
  return ($gvars.$ = ($gvars.global = self.$Native(Opal.global)));
};

Opal.modules["opal/jquery/constants"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $a, self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $truthy = Opal.truthy, $const_set = Opal.const_set;

  Opal.add_stubs('require,raise');
  
  self.$require("native");
  if ($truthy((($a = $$('JQUERY_CLASS', 'skip_raise')) ? 'constant' : nil))) {
    return nil
  } else if ($truthy(!!Opal.global.jQuery)) {
    return $const_set($nesting[0], 'JQUERY_CLASS', $const_set($nesting[0], 'JQUERY_SELECTOR', Opal.global.jQuery))
  } else if ($truthy(!!Opal.global.Zepto)) {
    
    $const_set($nesting[0], 'JQUERY_SELECTOR', Opal.global.Zepto);
    return $const_set($nesting[0], 'JQUERY_CLASS', Opal.global.Zepto.zepto.Z);
  } else {
    return self.$raise($$('NameError'), "Can't find jQuery or Zepto. jQuery must be included before opal-jquery")
  };
};

Opal.modules["opal/jquery/element"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $klass = Opal.klass, $defs = Opal.defs, $send = Opal.send, $to_a = Opal.to_a, $def = Opal.def, $alias = Opal.alias, $return_self = Opal.return_self, $truthy = Opal.truthy, $send2 = Opal.send2, $find_super = Opal.find_super;

  Opal.add_stubs('require,to_n,include,each,alias_native,attr_reader,call,next,append,nil?,raise,is_a?,has_key?,delete,from_object,gsub,upcase,[],compact,map,respond_to?,<<,Native,none?,arity,new,length');
  
  self.$require("native");
  self.$require("opal/jquery/constants");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Element');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    var $ = $$('JQUERY_SELECTOR').$to_n();
    self.$include($$('Enumerable'));
    $defs(self, '$find', function $$find(selector) {
      
      return $(selector)
    }, 1);
    $defs(self, '$[]', function $Element_$$$1(selector) {
      
      return $(selector)
    }, 1);
    $defs(self, '$id', function $$id(id) {
      
      
      var el = document.getElementById(id);

      if (!el) {
        return nil;
      }

      return $(el);
    
    }, 1);
    $defs(self, '$new', function $Element_new$2(tag) {
      
      
      
      if (tag == null) tag = "div";;
      return $(document.createElement(tag));;
    }, -1);
    $defs(self, '$parse', function $$parse(str) {
      
      return $.parseHTML ? $($.parseHTML(str)) : $(str);
    }, 1);
    $defs(self, '$expose', function $$expose($a) {
      var $post_args, methods, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      methods = $post_args;;
      return $send(methods, 'each', [], function $$3(method){var self = $$3.$$s == null ? this : $$3.$$s;

        
        
        if (method == null) method = nil;;
        return self.$alias_native(method);}, {$$arity: 1, $$s: self});
    }, -1);
    self.$attr_reader("selector");
    self.$alias_native("after");
    self.$alias_native("before");
    self.$alias_native("parent");
    self.$alias_native("parents");
    self.$alias_native("prev");
    self.$alias_native("remove");
    self.$alias_native("hide");
    self.$alias_native("show");
    self.$alias_native("toggle");
    self.$alias_native("children");
    self.$alias_native("blur");
    self.$alias_native("closest");
    self.$alias_native("detach");
    self.$alias_native("focus");
    self.$alias_native("find");
    self.$alias_native("next");
    self.$alias_native("siblings");
    self.$alias_native("text");
    self.$alias_native("trigger");
    self.$alias_native("append");
    self.$alias_native("prepend");
    self.$alias_native("serialize");
    self.$alias_native("is");
    self.$alias_native("filter");
    self.$alias_native("not");
    self.$alias_native("last");
    self.$alias_native("wrap");
    self.$alias_native("stop");
    self.$alias_native("clone");
    self.$alias_native("empty");
    self.$alias_native("get");
    
    $def(self, '$prop', function $$prop($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      return $send($$('Native'), 'call', [self, "prop"].concat($to_a(args)));
    }, -1);
    $alias(self, "succ", "next");
    $alias(self, "<<", "append");
    self.$alias_native("add_class", "addClass");
    self.$alias_native("append_to", "appendTo");
    self.$alias_native("has_class?", "hasClass");
    self.$alias_native("html=", "html");
    self.$alias_native("index");
    self.$alias_native("is?", "is");
    self.$alias_native("remove_attr", "removeAttr");
    self.$alias_native("remove_class", "removeClass");
    self.$alias_native("replace_all", "replaceAll");
    self.$alias_native("replace_with", "replaceWith");
    self.$alias_native("select");
    self.$alias_native("submit");
    self.$alias_native("click");
    self.$alias_native("text=", "text");
    self.$alias_native("toggle_class", "toggleClass");
    self.$alias_native("value=", "val");
    self.$alias_native("scroll_top=", "scrollTop");
    self.$alias_native("scroll_top", "scrollTop");
    self.$alias_native("scroll_left=", "scrollLeft");
    self.$alias_native("scroll_left", "scrollLeft");
    self.$alias_native("remove_attribute", "removeAttr");
    self.$alias_native("slide_down", "slideDown");
    self.$alias_native("slide_up", "slideUp");
    self.$alias_native("slide_toggle", "slideToggle");
    self.$alias_native("fade_toggle", "fadeToggle");
    self.$alias_native("height=", "height");
    self.$alias_native("width=", "width");
    self.$alias_native("outer_width", "outerWidth");
    self.$alias_native("outer_height", "outerHeight");
    
    $def(self, '$to_n', $return_self, 0);
    
    $def(self, '$[]', function $Element_$$$4(name) {
      var self = this;

      
      var value = self.attr(name);
      if(value === undefined) return nil;
      return value;
    
    }, 1);
    
    $def(self, '$[]=', function $Element_$$$eq$5(name, value) {
      var self = this;

      
      if ($truthy(value['$nil?']())) {
        return self.removeAttr(name)
      };
      return self.attr(name, value);;
    }, 2);
    
    $def(self, '$attr', function $$attr($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var size = args.length;
      switch (size) {
      case 1:
        var result = self.attr(args[0]);
        return( (result == null) ? nil : result );
        break;
      case 2:
        return self.attr(args[0], args[1]);
        break;
      default:
        self.$raise($$('ArgumentError'), "#attr only accepts 1 or 2 arguments")
      }
    ;
    }, -1);
    
    $def(self, '$has_attribute?', function $Element_has_attribute$ques$6(name) {
      var self = this;

      return self.attr(name) !== undefined;
    }, 1);
    
    $def(self, '$append_to_body', function $$append_to_body() {
      var self = this;

      return self.appendTo(document.body);
    }, 0);
    
    $def(self, '$append_to_head', function $$append_to_head() {
      var self = this;

      return self.appendTo(document.head);
    }, 0);
    
    $def(self, '$at', function $$at(index) {
      var self = this;

      
      var length = self.length;

      if (index < 0) {
        index += length;
      }

      if (index < 0 || index >= length) {
        return nil;
      }

      return $(self[index]);
    
    }, 1);
    
    $def(self, '$class_name', function $$class_name() {
      var self = this;

      
      var first = self[0];
      return (first && first.className) || "";
    
    }, 0);
    
    $def(self, '$class_name=', function $Element_class_name$eq$7(name) {
      var self = this;

      
      
      for (var i = 0, length = self.length; i < length; i++) {
        self[i].className = name;
      }
    ;
      return self;
    }, 1);
    
    $def(self, '$css', function $$css(name, value) {
      var self = this;

      
      
      if (value == null) value = nil;;
      if (($truthy(value['$nil?']()) && ($truthy(name['$is_a?']($$('String')))))) {
        return self.css(name)
      } else if ($truthy(name['$is_a?']($$('Hash')))) {
        self.css(name.$to_n())
      } else {
        self.css(name, value)
      };
      return self;
    }, -2);
    
    $def(self, '$animate', function $$animate(params) {
      var block = $$animate.$$p || nil, self = this, speed = nil;

      delete $$animate.$$p;
      
      ;
      speed = ($truthy(params['$has_key?']("speed")) ? (params.$delete("speed")) : (400));
      if ((block !== nil)) {
        return self.animate(params.$to_n(), speed, block)
      } else {
        return self.animate(params.$to_n(), speed)
      };
    }, 1);
    
    $def(self, '$data', function $$data($a) {
      var $post_args, args, self = this;

      
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      
      var result = self.data.apply(self, args);
      if (
        (typeof(result) === 'object') && !(result instanceof $$('JQUERY_CLASS'))
      ) {
        result = $$('JSON').$from_object(result);
      }
      return result == null ? nil : result;
    ;
    }, -1);
    
    $def(self, '$effect', function $$effect(name, $a) {
      var block = $$effect.$$p || nil, $post_args, args, self = this;

      delete $$effect.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      name = $send(name, 'gsub', [/_\w/], function $$8(match){
        
        
        if (match == null) match = nil;;
        return match['$[]'](1).$upcase();}, 1);
      args = $send(args, 'map', [], function $$9(a){
        
        
        if (a == null) a = nil;;
        if ($truthy(a['$respond_to?']("to_n"))) {
          return a.$to_n()
        } else {
          return nil
        };}, 1).$compact();
      args['$<<'](function() { ((block !== nil) ? (block.$call()) : nil) });
      return self[name].apply(self, args);
    }, -2);
    
    $def(self, '$visible?', function $Element_visible$ques$10() {
      var self = this;

      return self.is(':visible');
    }, 0);
    
    $def(self, '$offset', function $$offset() {
      var self = this;

      return self.$Native(self.offset())
    }, 0);
    
    $def(self, '$each', function $$each() {
      var $yield = $$each.$$p || nil, self = this;

      delete $$each.$$p;
      
      for (var i = 0, length = self.length; i < length; i++) {;
      Opal.yield1($yield, $(self[i]));
      };
      return self;
    }, 0);
    
    $def(self, '$first', function $$first() {
      var self = this;

      return self.length ? self.first() : nil;
    }, 0);
    
    $def(self, '$html', function $$html(content) {
      var self = this;

      
      ;
      
      if (content != null) {
        return self.html(content);
      }

      return self.html() || '';
    ;
    }, -1);
    
    $def(self, '$id', function $$id() {
      var self = this;

      
      var first = self[0];
      return (first && first.id) || "";
    
    }, 0);
    
    $def(self, '$id=', function $Element_id$eq$11(id) {
      var self = this;

      
      var first = self[0];

      if (first) {
        first.id = id;
      }

      return self;
    
    }, 1);
    
    $def(self, '$tag_name', function $$tag_name() {
      var self = this;

      return self.length > 0 ? self[0].tagName.toLowerCase() : nil
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      
      if      (self[0] === document) return '#<Element [document]>'
      else if (self[0] === window  ) return '#<Element [window]>'

      var val, el, str, result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        el  = self[i];
        if (!el.tagName) { return '#<Element ['+el.toString()+']'; }

        str = "<" + el.tagName.toLowerCase();

        if (val = el.id) str += (' id="' + val + '"');
        if (val = el.className) str += (' class="' + val + '"');

        result.push(str + '>');
      }

      return '#<Element [' + result.join(', ') + ']>';
    
    }, 0);
    
    $def(self, '$to_s', function $$to_s() {
      var self = this;

      
      var val, el, result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        el  = self[i];

        result.push(el.outerHTML)
      }

      return result.join(', ');
    
    }, 0);
    
    $def(self, '$length', function $$length() {
      var self = this;

      return self.length;
    }, 0);
    
    $def(self, '$any?', function $Element_any$ques$12() {
      var self = this;

      return self.length > 0;
    }, 0);
    
    $def(self, '$empty?', function $Element_empty$ques$13() {
      var self = this;

      return self.length === 0;
    }, 0);
    $alias(self, "empty?", "none?");
    
    $def(self, '$on', function $$on(name, sel) {
      var block = $$on.$$p || nil, self = this;

      delete $$on.$$p;
      
      ;
      
      if (sel == null) sel = nil;;
      
      var has_args = block.$arity() !== 0;

      var wrapper = function() {
        for(var args = new Array(arguments.length), i = 0, ii = args.length; i < ii; i++) {
          args[i] = arguments[i];
        }

        // Use preventDefault as a canary for native events
        if (has_args && args[0].preventDefault) {
          args[0] = $$('Event').$new(args[0]);
        }

        return block.apply(null, args);
      };

      block.$$jqwrap = wrapper;

      if (sel == nil) {
        self.on(name, wrapper);
      }
      else {
        self.on(name, sel, wrapper);
      }
    ;
      return block;
    }, -2);
    
    $def(self, '$one', function $$one(name, sel) {
      var block = $$one.$$p || nil, self = this;

      delete $$one.$$p;
      
      ;
      
      if (sel == null) sel = nil;;
      
      var has_args = block.$arity() !== 0;

      var wrapper = function() {
        for(var args = new Array(arguments.length), i = 0, ii = args.length; i < ii; i++) {
          args[i] = arguments[i];
        }

        // Use preventDefault as a canary for native events
        if (has_args && args[0].preventDefault) {
          args[0] = $$('Event').$new(args[0]);
        }

        return block.apply(null, args);
      };

      block.$$jqwrap = wrapper;

      if (sel == nil) {
        self.one(name, wrapper);
      }
      else {
        self.one(name, sel, wrapper);
      }
    ;
      return block;
    }, -2);
    
    $def(self, '$off', function $$off(name, sel, block) {
      var self = this;

      
      
      if (block == null) block = nil;;
      
      if (sel == null) {
        return self.off(name);
      }
      else if (block === nil) {
        return self.off(name, sel.$$jqwrap);
      }
      else {
        return self.off(name, sel, block.$$jqwrap);
      }
    ;
    }, -3);
    
    $def(self, '$serialize_array', function $$serialize_array() {
      var self = this;

      return $send((self.serializeArray()), 'map', [], function $$14(e){
        
        
        if (e == null) e = nil;;
        return $$('Hash').$new(e);}, 1)
    }, 0);
    $alias(self, "size", "length");
    
    $def(self, '$value', function $$value() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.val()))) {
        return $ret_or_1
      } else {
        return ""
      }
    }, 0);
    
    $def(self, '$height', function $$height() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.height()))) {
        return $ret_or_1
      } else {
        return nil
      }
    }, 0);
    
    $def(self, '$width', function $$width() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.width()))) {
        return $ret_or_1
      } else {
        return nil
      }
    }, 0);
    
    $def(self, '$position', function $$position() {
      var self = this;

      return self.$Native(self.position())
    }, 0);
    
    $def(self, '$==', function $Element_$eq_eq$15(other) {
      var self = this;

      return self.is(other);
    }, 1);
    
    $def(self, '$respond_to_missing?', function $Element_respond_to_missing$ques$16(name, _) {
      var $yield = $Element_respond_to_missing$ques$16.$$p || nil, self = this;

      delete $Element_respond_to_missing$ques$16.$$p;
      
      var method = self[name];
      if (typeof(method) === 'function') {
        return true;
      } else {
        return $send2(self, $find_super(self, 'respond_to_missing?', $Element_respond_to_missing$ques$16, false, true), 'respond_to_missing?', [name, _], $yield);
      }
    
    }, 2);
    return $def(self, '$method_missing', function $$method_missing(name, $a) {
      var block = $$method_missing.$$p || nil, $post_args, args, self = this;

      delete $$method_missing.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments, 1);
      
      args = $post_args;;
      if ((block !== nil)) {
        args['$<<'](block)
      };
      
      var method = self[name];
      if (typeof(method) === 'function') {
        return method.apply(self, args.$to_n());
      } else {
        return $send2(self, $find_super(self, 'method_missing', $$method_missing, false, true), 'method_missing', [name].concat($to_a(args)), block);
      }
    ;
    }, -2);
  })($nesting[0], $$('JQUERY_CLASS').$to_n(), $nesting);
};

Opal.modules["opal/jquery/window"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $klass = Opal.klass, $truthy = Opal.truthy, $def = Opal.def, $send = Opal.send, $to_a = Opal.to_a, $const_set = Opal.const_set, $gvars = Opal.gvars;

  Opal.add_stubs('require,include,find,on,element,to_proc,off,trigger,new');
  
  self.$require("opal/jquery/element");
  (function($base, $parent_nesting) {
    var self = $module($base, 'Browser');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $super, $parent_nesting) {
      var self = $klass($base, $super, 'Window');

      var $a, $b, $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

      $proto.element = nil;
      
      self.$include(($truthy((($b = $$('Native', 'skip_raise')) && ($a = $$$($b, 'Wrapper', 'skip_raise')) ? 'constant' : nil)) ? ($$$($$('Native'), 'Wrapper')) : ($$('Native'))));
      
      $def(self, '$element', function $$element() {
        var self = this, $ret_or_1 = nil;

        return (self.element = ($truthy(($ret_or_1 = self.element)) ? ($ret_or_1) : ($$('Element').$find(window))))
      }, 0);
      
      $def(self, '$on', function $$on($a) {
        var block = $$on.$$p || nil, $post_args, args, self = this;

        delete $$on.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        return $send(self.$element(), 'on', $to_a(args), block.$to_proc());
      }, -1);
      
      $def(self, '$off', function $$off($a) {
        var block = $$off.$$p || nil, $post_args, args, self = this;

        delete $$off.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        return $send(self.$element(), 'off', $to_a(args), block.$to_proc());
      }, -1);
      return $def(self, '$trigger', function $$trigger($a) {
        var $post_args, args, self = this;

        
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        return $send(self.$element(), 'trigger', $to_a(args));
      }, -1);
    })($nesting[0], null, $nesting)
  })($nesting[0], $nesting);
  $const_set($nesting[0], 'Window', $$$($$('Browser'), 'Window').$new(window));
  return ($gvars.window = $$('Window'));
};

Opal.modules["opal/jquery/document"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $class_variable_set = Opal.class_variable_set, $truthy = Opal.truthy, $class_variable_get = Opal.class_variable_get, $def = Opal.def, $send = Opal.send, $const_set = Opal.const_set, $gvars = Opal.gvars;

  Opal.add_stubs('require,to_n,call,new,ready?,resolve,module_function,find,extend');
  
  self.$require("opal/jquery/constants");
  self.$require("opal/jquery/element");
  (function($base, $parent_nesting) {
    var self = $module($base, 'Browser');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $parent_nesting) {
      var self = $module($base, 'DocumentMethods');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      $class_variable_set($nesting[0], '@@__isReady', false);
      var $ = $$('JQUERY_SELECTOR').$to_n();
      
      $def(self, '$ready?', function $DocumentMethods_ready$ques$1() {
        var block = $DocumentMethods_ready$ques$1.$$p || nil;

        delete $DocumentMethods_ready$ques$1.$$p;
        
        ;
        if ((block !== nil)) {
          if ($truthy($class_variable_get($nesting[0], '@@__isReady', false))) {
            return block.$call()
          } else {
            return $(block)
          }
        } else {
          return nil
        };
      }, 0);
      
      $def(self, '$ready', function $$ready() {
        var promise = nil;

        
        promise = $$('Promise').$new();
        $send($$('Document'), 'ready?', [], function $$2(){
          return promise.$resolve()}, 0);
        return promise;
      }, 0);
      self.$module_function("ready?");
      $send(self, 'ready?', [], function $DocumentMethods$3(){
        return $class_variable_set($nesting[0], '@@__isReady', true)}, 0);
      
      $def(self, '$title', function $$title() {
        
        return document.title;
      }, 0);
      
      $def(self, '$title=', function $DocumentMethods_title$eq$4(title) {
        
        return document.title = title;
      }, 1);
      
      $def(self, '$head', function $$head() {
        
        return $$('Element').$find(document.head)
      }, 0);
      return $def(self, '$body', function $$body() {
        
        return $$('Element').$find(document.body)
      }, 0);
    })($nesting[0], $nesting)
  })($nesting[0], $nesting);
  $const_set($nesting[0], 'Document', $$('Element').$find(document));
  $$('Document').$extend($$$($$('Browser'), 'DocumentMethods'));
  return ($gvars.document = $$('Document'));
};

Opal.modules["opal/jquery/event"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $klass = Opal.klass, $assign_ivar = Opal.assign_ivar, $def = Opal.def, $return_ivar = Opal.return_ivar, $alias = Opal.alias;

  Opal.add_stubs('require,to_n,element,stop,prevent,prevented?,stopped?,stop_immediate');
  
  self.$require("opal/jquery/constants");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Event');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto["native"] = nil;
    
    var $ = $$('JQUERY_SELECTOR').$to_n();
    
    $def(self, '$initialize', $assign_ivar("native"), 0);
    
    $def(self, '$to_n', $return_ivar("native"), 0);
    
    $def(self, '$[]', function $Event_$$$1(name) {
      var self = this;

      return self["native"][name]
    }, 1);
    
    $def(self, '$type', function $$type() {
      var self = this;

      return self["native"].type
    }, 0);
    
    $def(self, '$element', function $$element() {
      var self = this;

      return $(self["native"].currentTarget)
    }, 0);
    $alias(self, "current_target", "element");
    
    $def(self, '$target', function $$target() {
      var self = this;

      return $(self["native"].target)
    }, 0);
    
    $def(self, '$prevented?', function $Event_prevented$ques$2() {
      var self = this;

      return self["native"].isDefaultPrevented()
    }, 0);
    
    $def(self, '$prevent', function $$prevent() {
      var self = this;

      return self["native"].preventDefault()
    }, 0);
    
    $def(self, '$stopped?', function $Event_stopped$ques$3() {
      var self = this;

      return self["native"].isPropagationStopped()
    }, 0);
    
    $def(self, '$stop', function $$stop() {
      var self = this;

      return self["native"].stopPropagation()
    }, 0);
    
    $def(self, '$stop_immediate', function $$stop_immediate() {
      var self = this;

      return self["native"].stopImmediatePropagation()
    }, 0);
    
    $def(self, '$kill', function $$kill() {
      var self = this;

      
      self.$stop();
      return self.$prevent();
    }, 0);
    
    $def(self, '$page_x', function $$page_x() {
      var self = this;

      return self["native"].pageX
    }, 0);
    
    $def(self, '$page_y', function $$page_y() {
      var self = this;

      return self["native"].pageY
    }, 0);
    
    $def(self, '$touch_x', function $$touch_x() {
      var self = this;

      return self["native"].originalEvent.touches[0].pageX
    }, 0);
    
    $def(self, '$touch_y', function $$touch_y() {
      var self = this;

      return self["native"].originalEvent.touches[0].pageY
    }, 0);
    
    $def(self, '$ctrl_key', function $$ctrl_key() {
      var self = this;

      return self["native"].ctrlKey
    }, 0);
    
    $def(self, '$meta_key', function $$meta_key() {
      var self = this;

      return self["native"].metaKey
    }, 0);
    
    $def(self, '$alt_key', function $$alt_key() {
      var self = this;

      return self["native"].altKey
    }, 0);
    
    $def(self, '$shift_key', function $$shift_key() {
      var self = this;

      return self["native"].shiftKey
    }, 0);
    
    $def(self, '$key_code', function $$key_code() {
      var self = this;

      return self["native"].keyCode
    }, 0);
    
    $def(self, '$which', function $$which() {
      var self = this;

      return self["native"].which
    }, 0);
    $alias(self, "default_prevented?", "prevented?");
    $alias(self, "prevent_default", "prevent");
    $alias(self, "propagation_stopped?", "stopped?");
    $alias(self, "stop_propagation", "stop");
    return $alias(self, "stop_immediate_propagation", "stop_immediate");
  })($nesting[0], null, $nesting);
};

Opal.modules["json"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $$$ = Opal.$$$, $module = Opal.module, $klass = Opal.klass, $send = Opal.send, $Object = Opal.Object, $hash2 = Opal.hash2, $eqeqeq = Opal.eqeqeq, $defs = Opal.defs, $truthy = Opal.truthy, $def = Opal.def, $return_val = Opal.return_val;

  Opal.add_stubs('raise,new,push,[]=,[],create_id,json_create,const_get,attr_accessor,create_id=,===,parse,generate,from_object,merge,to_json,responds_to?,to_io,write,to_s,to_a,strftime');
  
  (function($base, $parent_nesting) {
    var self = $module($base, 'JSON');

    var $a, $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

    
    $klass($nesting[0], $$('StandardError'), 'JSONError');
    $klass($nesting[0], $$('JSONError'), 'ParserError');
    
    var $hasOwn = Opal.hasOwnProperty;

    function $parse(source) {
      try {
        return JSON.parse(source);
      } catch (e) {
        self.$raise($$$($$('JSON'), 'ParserError'), e.message);
      }
    };

    function to_opal(value, options) {
      var klass, arr, hash, i, ii, k;

      switch (typeof value) {
        case 'string':
          return value;

        case 'number':
          return value;

        case 'boolean':
          return !!value;

        case 'undefined':
          return nil;

        case 'object':
          if (!value) return nil;

          if (value.$$is_array) {
            arr = (options.array_class).$new();

            for (i = 0, ii = value.length; i < ii; i++) {
              (arr).$push(to_opal(value[i], options));
            }

            return arr;
          }
          else {
            hash = (options.object_class).$new();

            for (k in value) {
              if ($hasOwn.call(value, k)) {
                ($a = [k, to_opal(value[k], options)], $send((hash), '[]=', $a), $a[$a.length - 1]);
              }
            }

            if (!options.parse && (klass = (hash)['$[]']($$('JSON').$create_id())) != nil) {
              return $Object.$const_get(klass).$json_create(hash);
            }
            else {
              return hash;
            }
          }
        }
    };
  ;
    (function(self, $parent_nesting) {
      
      return self.$attr_accessor("create_id")
    })(Opal.get_singleton_class(self), $nesting);
    self['$create_id=']("json_class");
    $defs(self, '$[]', function $JSON_$$$1(value, options) {
      var self = this;

      
      
      if (options == null) options = $hash2([], {});;
      if ($eqeqeq($$('String'), value)) {
        return self.$parse(value, options)
      } else {
        return self.$generate(value, options)
      };
    }, -2);
    $defs(self, '$parse', function $$parse(source, options) {
      var self = this;

      
      
      if (options == null) options = $hash2([], {});;
      return self.$from_object($parse(source), options.$merge($hash2(["parse"], {"parse": true})));
    }, -2);
    $defs(self, '$parse!', function $JSON_parse$excl$2(source, options) {
      var self = this;

      
      
      if (options == null) options = $hash2([], {});;
      return self.$parse(source, options);
    }, -2);
    $defs(self, '$load', function $$load(source, options) {
      var self = this;

      
      
      if (options == null) options = $hash2([], {});;
      return self.$from_object($parse(source), options);
    }, -2);
    $defs(self, '$from_object', function $$from_object(js_object, options) {
      var $ret_or_1 = nil;

      
      
      if (options == null) options = $hash2([], {});;
      if ($truthy(($ret_or_1 = options['$[]']("object_class")))) {
        $ret_or_1
      } else {
        options['$[]=']("object_class", $$('Hash'))
      };
      if ($truthy(($ret_or_1 = options['$[]']("array_class")))) {
        $ret_or_1
      } else {
        options['$[]=']("array_class", $$('Array'))
      };
      return to_opal(js_object, options.$$smap);;
    }, -2);
    $defs(self, '$generate', function $$generate(obj, options) {
      
      
      
      if (options == null) options = $hash2([], {});;
      return obj.$to_json(options);
    }, -2);
    return $defs(self, '$dump', function $$dump(obj, io, limit) {
      var self = this, string = nil;

      
      
      if (io == null) io = nil;;
      
      if (limit == null) limit = nil;;
      string = self.$generate(obj);
      if ($truthy(io)) {
        
        if ($truthy(io['$responds_to?']("to_io"))) {
          io = io.$to_io()
        };
        io.$write(string);
        return io;
      } else {
        return string
      };
    }, -2);
  })($nesting[0], $nesting);
  (function($base, $super) {
    var self = $klass($base, $super, 'Object');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      return self.$to_s().$to_json()
    }, 0)
  })($nesting[0], null);
  (function($base) {
    var self = $module($base, 'Enumerable');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      return self.$to_a().$to_json()
    }, 0)
  })($nesting[0]);
  (function($base, $super) {
    var self = $klass($base, $super, 'Array');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        result.push((self[i]).$to_json());
      }

      return '[' + result.join(',') + ']';
    
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'Boolean');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'Hash');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        result.push((key).$to_s().$to_json() + ':' + (value).$to_json());
      }

      return '{' + result.join(',') + '}';
    
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'NilClass');

    
    return $def(self, '$to_json', $return_val("null"), 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'Numeric');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      return self.toString();
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'String');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      return JSON.stringify(self);
    }, 0)
  })($nesting[0], null);
  (function($base, $super) {
    var self = $klass($base, $super, 'Time');

    
    return $def(self, '$to_json', function $$to_json() {
      var self = this;

      return self.$strftime("%FT%T%z").$to_json()
    }, 0)
  })($nesting[0], null);
  return (function($base, $super) {
    var self = $klass($base, $super, 'Date');

    
    
    
    $def(self, '$to_json', function $$to_json() {
      var self = this;

      return self.$to_s().$to_json()
    }, 0);
    return $def(self, '$as_json', function $$as_json() {
      var self = this;

      return self.$to_s()
    }, 0);
  })($nesting[0], null);
};

Opal.modules["promise"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $klass = Opal.klass, $defs = Opal.defs, $hash2 = Opal.hash2, $def = Opal.def, $eqeqeq = Opal.eqeqeq, $truthy = Opal.truthy, $return_ivar = Opal.return_ivar, $not = Opal.not, $send = Opal.send, $to_a = Opal.to_a, $rb_plus = Opal.rb_plus, $alias = Opal.alias, $send2 = Opal.send2, $find_super = Opal.find_super, $rb_le = Opal.rb_le, $rb_minus = Opal.rb_minus, $const_set = Opal.const_set;

  Opal.add_stubs('resolve,new,reject,attr_reader,===,value,key?,keys,!=,==,<<,>>,exception?,[],resolved?,rejected?,!,error,include?,action,realized?,raise,^,call,resolve!,exception!,any?,each,reject!,there_can_be_only_one!,then,to_proc,fail,always,trace,class,object_id,+,inspect,rescue,fail!,then!,always!,to_v2,itself,nil?,prev,act?,push,concat,it,proc,reverse,pop,<=,length,shift,-,wait,map,reduce,try,tap,all?,find,collect,inject');
  
  (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'Promise');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.value = $proto.action = $proto.realized = $proto.next = $proto.delayed = $proto.error = $proto.prev = nil;
    
    $defs(self, '$value', function $$value(value) {
      var self = this;

      return self.$new().$resolve(value)
    }, 1);
    $defs(self, '$error', function $$error(value) {
      var self = this;

      return self.$new().$reject(value)
    }, 1);
    $defs(self, '$when', function $$when($a) {
      var $post_args, promises;

      
      
      $post_args = Opal.slice.call(arguments);
      
      promises = $post_args;;
      return $$('When').$new(promises);
    }, -1);
    self.$attr_reader("error", "prev", "next");
    
    $def(self, '$initialize', function $$initialize(action) {
      var self = this;

      
      
      if (action == null) action = $hash2([], {});;
      self.action = action;
      self.realized = false;
      self.exception = false;
      self.value = nil;
      self.error = nil;
      self.delayed = false;
      self.prev = nil;
      return (self.next = []);
    }, -1);
    
    $def(self, '$value', function $$value() {
      var self = this;

      if ($eqeqeq($$('Promise'), self.value)) {
        return self.value.$value()
      } else {
        return self.value
      }
    }, 0);
    
    $def(self, '$act?', function $Promise_act$ques$1() {
      var self = this, $ret_or_1 = nil;

      if ($truthy(($ret_or_1 = self.action['$key?']("success")))) {
        return $ret_or_1
      } else {
        return self.action['$key?']("always")
      }
    }, 0);
    
    $def(self, '$action', function $$action() {
      var self = this;

      return self.action.$keys()
    }, 0);
    
    $def(self, '$exception?', $return_ivar("exception"), 0);
    
    $def(self, '$realized?', function $Promise_realized$ques$2() {
      var self = this;

      return self.realized['$!='](false)
    }, 0);
    
    $def(self, '$resolved?', function $Promise_resolved$ques$3() {
      var self = this;

      return self.realized['$==']("resolve")
    }, 0);
    
    $def(self, '$rejected?', function $Promise_rejected$ques$4() {
      var self = this;

      return self.realized['$==']("reject")
    }, 0);
    
    $def(self, '$^', function $Promise_$$5(promise) {
      var self = this;

      
      promise['$<<'](self);
      self['$>>'](promise);
      return promise;
    }, 1);
    
    $def(self, '$<<', function $Promise_$lt$lt$6(promise) {
      var self = this;

      
      self.prev = promise;
      return self;
    }, 1);
    
    $def(self, '$>>', function $Promise_$gt$gt$7(promise) {
      var self = this;

      
      self.next['$<<'](promise);
      if ($truthy(self['$exception?']())) {
        promise.$reject(self.delayed['$[]'](0))
      } else if ($truthy(self['$resolved?']())) {
        promise.$resolve(($truthy(self.delayed) ? (self.delayed['$[]'](0)) : (self.$value())))
      } else if ($truthy(self['$rejected?']())) {
        if (($not(self.action['$key?']("failure")) || ($eqeqeq($$('Promise'), ($truthy(self.delayed) ? (self.delayed['$[]'](0)) : (self.error)))))) {
          promise.$reject(($truthy(self.delayed) ? (self.delayed['$[]'](0)) : (self.$error())))
        } else if ($truthy(promise.$action()['$include?']("always"))) {
          promise.$reject(($truthy(self.delayed) ? (self.delayed['$[]'](0)) : (self.$error())))
        }
      };
      return self;
    }, 1);
    
    $def(self, '$resolve', function $$resolve(value) {
      var self = this, block = nil, $ret_or_1 = nil, e = nil;

      
      
      if (value == null) value = nil;;
      if ($truthy(self['$realized?']())) {
        self.$raise($$('ArgumentError'), "the promise has already been realized")
      };
      if ($eqeqeq($$('Promise'), value)) {
        return value['$<<'](self.prev)['$^'](self)
      };
      
      try {
        
        block = ($truthy(($ret_or_1 = self.action['$[]']("success"))) ? ($ret_or_1) : (self.action['$[]']("always")));
        if ($truthy(block)) {
          value = block.$call(value)
        };
        self['$resolve!'](value);
      } catch ($err) {
        if (Opal.rescue($err, [$$('Exception')])) {(e = $err)
          try {
            self['$exception!'](e)
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      };;
      return self;
    }, -1);
    
    $def(self, '$resolve!', function $Promise_resolve$excl$8(value) {
      var self = this;

      
      self.realized = "resolve";
      self.value = value;
      if ($truthy(self.next['$any?']())) {
        return $send(self.next, 'each', [], function $$9(p){
          
          
          if (p == null) p = nil;;
          return p.$resolve(value);}, 1)
      } else {
        return (self.delayed = [value])
      };
    }, 1);
    
    $def(self, '$reject', function $$reject(value) {
      var self = this, block = nil, $ret_or_1 = nil, e = nil;

      
      
      if (value == null) value = nil;;
      if ($truthy(self['$realized?']())) {
        self.$raise($$('ArgumentError'), "the promise has already been realized")
      };
      if ($eqeqeq($$('Promise'), value)) {
        return value['$<<'](self.prev)['$^'](self)
      };
      
      try {
        
        block = ($truthy(($ret_or_1 = self.action['$[]']("failure"))) ? ($ret_or_1) : (self.action['$[]']("always")));
        if ($truthy(block)) {
          value = block.$call(value)
        };
        if ($truthy(self.action['$key?']("always"))) {
          self['$resolve!'](value)
        } else {
          self['$reject!'](value)
        };
      } catch ($err) {
        if (Opal.rescue($err, [$$('Exception')])) {(e = $err)
          try {
            self['$exception!'](e)
          } finally { Opal.pop_exception(); }
        } else { throw $err; }
      };;
      return self;
    }, -1);
    
    $def(self, '$reject!', function $Promise_reject$excl$10(value) {
      var self = this;

      
      self.realized = "reject";
      self.error = value;
      if ($truthy(self.next['$any?']())) {
        return $send(self.next, 'each', [], function $$11(p){
          
          
          if (p == null) p = nil;;
          return p.$reject(value);}, 1)
      } else {
        return (self.delayed = [value])
      };
    }, 1);
    
    $def(self, '$exception!', function $Promise_exception$excl$12(error) {
      var self = this;

      
      self.exception = true;
      return self['$reject!'](error);
    }, 1);
    
    $def(self, '$then', function $$then() {
      var block = $$then.$$p || nil, self = this;

      delete $$then.$$p;
      
      ;
      return self['$^']($$('Promise').$new($hash2(["success"], {"success": block})));
    }, 0);
    
    $def(self, '$then!', function $Promise_then$excl$13() {
      var block = $Promise_then$excl$13.$$p || nil, self = this;

      delete $Promise_then$excl$13.$$p;
      
      ;
      self['$there_can_be_only_one!']();
      return $send(self, 'then', [], block.$to_proc());
    }, 0);
    
    $def(self, '$fail', function $$fail() {
      var block = $$fail.$$p || nil, self = this;

      delete $$fail.$$p;
      
      ;
      return self['$^']($$('Promise').$new($hash2(["failure"], {"failure": block})));
    }, 0);
    
    $def(self, '$fail!', function $Promise_fail$excl$14() {
      var block = $Promise_fail$excl$14.$$p || nil, self = this;

      delete $Promise_fail$excl$14.$$p;
      
      ;
      self['$there_can_be_only_one!']();
      return $send(self, 'fail', [], block.$to_proc());
    }, 0);
    
    $def(self, '$always', function $$always() {
      var block = $$always.$$p || nil, self = this;

      delete $$always.$$p;
      
      ;
      return self['$^']($$('Promise').$new($hash2(["always"], {"always": block})));
    }, 0);
    
    $def(self, '$always!', function $Promise_always$excl$15() {
      var block = $Promise_always$excl$15.$$p || nil, self = this;

      delete $Promise_always$excl$15.$$p;
      
      ;
      self['$there_can_be_only_one!']();
      return $send(self, 'always', [], block.$to_proc());
    }, 0);
    
    $def(self, '$trace', function $$trace(depth) {
      var block = $$trace.$$p || nil, self = this;

      delete $$trace.$$p;
      
      ;
      
      if (depth == null) depth = nil;;
      return self['$^']($$('Trace').$new(depth, block));
    }, -1);
    
    $def(self, '$trace!', function $Promise_trace$excl$16($a) {
      var block = $Promise_trace$excl$16.$$p || nil, $post_args, args, self = this;

      delete $Promise_trace$excl$16.$$p;
      
      ;
      
      $post_args = Opal.slice.call(arguments);
      
      args = $post_args;;
      self['$there_can_be_only_one!']();
      return $send(self, 'trace', $to_a(args), block.$to_proc());
    }, -1);
    
    $def(self, '$there_can_be_only_one!', function $Promise_there_can_be_only_one$excl$17() {
      var self = this;

      if ($truthy(self.next['$any?']())) {
        return self.$raise($$('ArgumentError'), "a promise has already been chained")
      } else {
        return nil
      }
    }, 0);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this, result = nil, $ret_or_1 = nil;

      
      result = "#<" + (self.$class()) + "(" + (self.$object_id()) + ")";
      if ($truthy(self.next['$any?']())) {
        result = $rb_plus(result, " >> " + (self.next.$inspect()))
      };
      result = $rb_plus(result, ($truthy(self['$realized?']()) ? (": " + (($truthy(($ret_or_1 = self.value)) ? ($ret_or_1) : (self.error)).$inspect()) + ">") : (">")));
      return result;
    }, 0);
    
    $def(self, '$to_v2', function $$to_v2() {
      var self = this, v2 = nil;

      
      v2 = $$('PromiseV2').$new();
      $send($send(self, 'then', [], function $$18(i){
        
        
        if (i == null) i = nil;;
        return v2.$resolve(i);}, 1), 'rescue', [], function $$19(i){
        
        
        if (i == null) i = nil;;
        return v2.$reject(i);}, 1);
      return v2;
    }, 0);
    $alias(self, "catch", "fail");
    $alias(self, "catch!", "fail!");
    $alias(self, "do", "then");
    $alias(self, "do!", "then!");
    $alias(self, "ensure", "always");
    $alias(self, "ensure!", "always!");
    $alias(self, "finally", "always");
    $alias(self, "finally!", "always!");
    $alias(self, "rescue", "fail");
    $alias(self, "rescue!", "fail!");
    $alias(self, "to_n", "to_v2");
    $alias(self, "to_v1", "itself");
    (function($base, $super, $parent_nesting) {
      var self = $klass($base, $super, 'Trace');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      $defs(self, '$it', function $$it(promise) {
        var self = this, current = nil, prev = nil;

        
        current = [];
        if (($truthy(promise['$act?']()) || ($truthy(promise.$prev()['$nil?']())))) {
          current.$push(promise.$value())
        };
        prev = promise.$prev();
        if ($truthy(prev)) {
          return current.$concat(self.$it(prev))
        } else {
          return current
        };
      }, 1);
      return $def(self, '$initialize', function $$initialize(depth, block) {
        var $yield = $$initialize.$$p || nil, self = this;

        delete $$initialize.$$p;
        
        self.depth = depth;
        return $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', [$hash2(["success"], {"success": $send(self, 'proc', [], function $$20(){var self = $$20.$$s == null ? this : $$20.$$s, trace = nil;

          
          trace = $$('Trace').$it(self).$reverse();
          trace.$pop();
          if (($truthy(depth) && ($truthy($rb_le(depth, trace.$length()))))) {
            trace.$shift($rb_minus(trace.$length(), depth))
          };
          return $send(block, 'call', $to_a(trace));}, {$$arity: 0, $$s: self})})], null);
      }, 2);
    })($nesting[0], self, $nesting);
    return (function($base, $super, $parent_nesting) {
      var self = $klass($base, $super, 'When');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

      $proto.wait = nil;
      
      
      $def(self, '$initialize', function $$initialize(promises) {
        var $yield = $$initialize.$$p || nil, self = this;

        delete $$initialize.$$p;
        
        
        if (promises == null) promises = [];;
        $send2(self, $find_super(self, 'initialize', $$initialize, false, true), 'initialize', [], null);
        self.wait = [];
        return $send(promises, 'each', [], function $$21(promise){var self = $$21.$$s == null ? this : $$21.$$s;

          
          
          if (promise == null) promise = nil;;
          return self.$wait(promise);}, {$$arity: 1, $$s: self});
      }, -1);
      
      $def(self, '$each', function $$each() {
        var block = $$each.$$p || nil, self = this;

        delete $$each.$$p;
        
        ;
        if (!$truthy(block)) {
          self.$raise($$('ArgumentError'), "no block given")
        };
        return $send(self, 'then', [], function $$22(values){
          
          
          if (values == null) values = nil;;
          return $send(values, 'each', [], block.$to_proc());}, 1);
      }, 0);
      
      $def(self, '$collect', function $$collect() {
        var block = $$collect.$$p || nil, self = this;

        delete $$collect.$$p;
        
        ;
        if (!$truthy(block)) {
          self.$raise($$('ArgumentError'), "no block given")
        };
        return $send(self, 'then', [], function $$23(values){
          
          
          if (values == null) values = nil;;
          return $$('When').$new($send(values, 'map', [], block.$to_proc()));}, 1);
      }, 0);
      
      $def(self, '$inject', function $$inject($a) {
        var block = $$inject.$$p || nil, $post_args, args, self = this;

        delete $$inject.$$p;
        
        ;
        
        $post_args = Opal.slice.call(arguments);
        
        args = $post_args;;
        return $send(self, 'then', [], function $$24(values){
          
          
          if (values == null) values = nil;;
          return $send(values, 'reduce', $to_a(args), block.$to_proc());}, 1);
      }, -1);
      
      $def(self, '$wait', function $$wait(promise) {
        var self = this;

        
        if (!$eqeqeq($$('Promise'), promise)) {
          promise = $$('Promise').$value(promise)
        };
        if ($truthy(promise['$act?']())) {
          promise = promise.$then()
        };
        self.wait['$<<'](promise);
        $send(promise, 'always', [], function $$25(){var self = $$25.$$s == null ? this : $$25.$$s;
          if (self.next == null) self.next = nil;

          if ($truthy(self.next['$any?']())) {
            return self.$try()
          } else {
            return nil
          }}, {$$arity: 0, $$s: self});
        return self;
      }, 1);
      
      $def(self, '$>>', function $When_$gt$gt$26($a) {
        var $post_args, $rest_arg, $yield = $When_$gt$gt$26.$$p || nil, self = this;

        delete $When_$gt$gt$26.$$p;
        
        
        $post_args = Opal.slice.call(arguments);
        
        $rest_arg = $post_args;;
        return $send($send2(self, $find_super(self, '>>', $When_$gt$gt$26, false, true), '>>', $to_a($rest_arg), $yield), 'tap', [], function $$27(){var self = $$27.$$s == null ? this : $$27.$$s;

          return self.$try()}, {$$arity: 0, $$s: self});
      }, -1);
      
      $def(self, '$try', function $When_try$28() {
        var self = this, promise = nil;

        if ($truthy($send(self.wait, 'all?', [], "realized?".$to_proc()))) {
          
          promise = $send(self.wait, 'find', [], "rejected?".$to_proc());
          if ($truthy(promise)) {
            return self.$reject(promise.$error())
          } else {
            return self.$resolve($send(self.wait, 'map', [], "value".$to_proc()))
          };
        } else {
          return nil
        }
      }, 0);
      $alias(self, "map", "collect");
      $alias(self, "reduce", "inject");
      return $alias(self, "and", "wait");
    })($nesting[0], self, $nesting);
  })($nesting[0], null, $nesting);
  return $const_set($nesting[0], 'PromiseV1', $$('Promise'));
};

Opal.modules["opal/jquery/http"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $klass = Opal.klass, $const_set = Opal.const_set, $send = Opal.send, $hash2 = Opal.hash2, $defs = Opal.defs, $def = Opal.def, $truthy = Opal.truthy, $return_ivar = Opal.return_ivar;

  Opal.add_stubs('require,to_n,each,define_singleton_method,send,new,define_method,attr_reader,delete,update,upcase,succeed,fail,promise,parse,private,tap,proc,ok?,resolve,reject,from_object,call');
  
  self.$require("json");
  self.$require("native");
  self.$require("promise");
  self.$require("opal/jquery/constants");
  return (function($base, $super, $parent_nesting) {
    var self = $klass($base, $super, 'HTTP');

    var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting), $proto = self.$$prototype;

    $proto.settings = $proto.payload = $proto.url = $proto.method = $proto.handler = $proto.json = $proto.body = $proto.xhr = $proto.promise = $proto.status_code = nil;
    
    var $ = $$('JQUERY_SELECTOR').$to_n();
    $const_set($nesting[0], 'ACTIONS', ["get", "post", "put", "delete", "patch", "head"]);
    $send($$('ACTIONS'), 'each', [], function $HTTP$1(action){var self = $HTTP$1.$$s == null ? this : $HTTP$1.$$s;

      
      
      if (action == null) action = nil;;
      $send(self, 'define_singleton_method', [action], function $$2(url, options){var block = $$2.$$p || nil, self = $$2.$$s == null ? this : $$2.$$s;

        delete $$2.$$p;
        
        ;
        
        if (url == null) url = nil;;
        
        if (options == null) options = $hash2([], {});;
        return self.$new().$send(action, url, options, block);}, {$$arity: -2, $$s: self});
      return $send(self, 'define_method', [action], function $$4(url, options){var block = $$4.$$p || nil, self = $$4.$$s == null ? this : $$4.$$s;

        delete $$4.$$p;
        
        ;
        
        if (url == null) url = nil;;
        
        if (options == null) options = $hash2([], {});;
        return self.$send(action, url, options, block);}, {$$arity: -2, $$s: self});}, {$$arity: 1, $$s: self});
    $defs(self, '$setup', function $$setup() {
      
      return $$('Hash').$new($.ajaxSetup())
    }, 0);
    $defs(self, '$setup=', function $HTTP_setup$eq$5(settings) {
      
      return $.ajaxSetup(settings.$to_n())
    }, 1);
    self.$attr_reader("body", "error_message", "method", "status_code", "url", "xhr");
    
    $def(self, '$initialize', function $$initialize() {
      var self = this;

      
      self.settings = $hash2([], {});
      return (self.ok = true);
    }, 0);
    
    $def(self, '$send', function $$send(method, url, options, block) {
      var $a, self = this, settings = nil, payload = nil;

      
      self.method = method;
      self.url = url;
      self.payload = options.$delete("payload");
      self.handler = block;
      self.settings.$update(options);
      $a = [self.settings.$to_n(), self.payload], (settings = $a[0]), (payload = $a[1]), $a;
      
      if (typeof(payload) === 'string') {
        settings.data = payload;
      }
      else if (payload != nil) {
        settings.data = payload.$to_json();
        settings.contentType = 'application/json';
      }

      settings.url  = self.url;
      settings.type = self.method.$upcase();

      settings.success = function(data, status, xhr) {
        return self.$succeed(data, status, xhr);
      };

      settings.error = function(xhr, status, error) {
        return self.$fail(xhr, status, error);
      };

      $.ajax(settings);
    ;
      if ($truthy(self.handler)) {
        return self
      } else {
        return self.$promise()
      };
    }, 4);
    
    $def(self, '$json', function $$json() {
      var self = this, $ret_or_1 = nil;

      return (self.json = ($truthy(($ret_or_1 = self.json)) ? ($ret_or_1) : ($$('JSON').$parse(self.body))))
    }, 0);
    
    $def(self, '$ok?', $return_ivar("ok"), 0);
    
    $def(self, '$get_header', function $$get_header(key) {
      var self = this;

      
      var value = self.xhr.getResponseHeader(key);
      return (value === null) ? nil : value;
    
    }, 1);
    
    $def(self, '$inspect', function $$inspect() {
      var self = this;

      return "#<HTTP @url=" + (self.url) + " @method=" + (self.method) + ">"
    }, 0);
    self.$private();
    
    $def(self, '$promise', function $$promise() {
      var self = this;

      
      if ($truthy(self.promise)) {
        return self.promise
      };
      return (self.promise = $send($$('Promise').$new(), 'tap', [], function $$6(promise){var self = $$6.$$s == null ? this : $$6.$$s;

        
        
        if (promise == null) promise = nil;;
        return (self.handler = $send(self, 'proc', [], function $$7(res){
          
          
          if (res == null) res = nil;;
          if ($truthy(res['$ok?']())) {
            return promise.$resolve(res)
          } else {
            return promise.$reject(res)
          };}, 1));}, {$$arity: 1, $$s: self}));
    }, 0);
    
    $def(self, '$succeed', function $$succeed(data, status, xhr) {
      var self = this;

      
      
      self.body = data;
      self.xhr  = xhr;
      self.status_code = xhr.status;

      if (typeof(data) === 'object') {
        self.json = $$('JSON').$from_object(data);
      }
    ;
      if ($truthy(self.handler)) {
        return self.handler.$call(self)
      } else {
        return nil
      };
    }, 3);
    return $def(self, '$fail', function $$fail(xhr, status, error) {
      var self = this;

      
      
      self.body = xhr.responseText;
      self.xhr = xhr;
      self.status_code = xhr.status;
    ;
      self.ok = false;
      if ($truthy(self.handler)) {
        return self.handler.$call(self)
      } else {
        return nil
      };
    }, 3);
  })($nesting[0], null, $nesting);
};

Opal.modules["opal/jquery/kernel"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var $nesting = [], nil = Opal.nil, $module = Opal.module, $def = Opal.def;

  return (function($base) {
    var self = $module($base, 'Kernel');

    
    return $def(self, '$alert', function $$alert(msg) {
      
      
      alert(msg);
      return nil;
    }, 1)
  })($nesting[0])
};

Opal.modules["opal/jquery"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, nil = Opal.nil;

  Opal.add_stubs('require');
  
  self.$require("opal/jquery/window");
  self.$require("opal/jquery/document");
  self.$require("opal/jquery/element");
  self.$require("opal/jquery/event");
  self.$require("opal/jquery/http");
  return self.$require("opal/jquery/kernel");
};

Opal.modules["opal-jquery"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, nil = Opal.nil;

  Opal.add_stubs('require');
  return self.$require("opal/jquery")
};

Opal.modules["opal/httpget"] = function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], nil = Opal.nil, $module = Opal.module, $klass = Opal.klass, $assign_ivar_val = Opal.assign_ivar_val, $def = Opal.def;

  Opal.add_stubs('puts,require,attr_reader,module_function,length,mypreload');
  
  
  self.$puts("Ruby engine is opal");
  self.$require("opal/httpget.rb"+ '/../' + "httpget/version");
  self.$require("jquery-3.6.0.min");
  self.$require("opal-jquery");;
  return (function($base, $parent_nesting) {
    var self = $module($base, 'Opal');

    var $nesting = [self].concat($parent_nesting);

    return (function($base, $parent_nesting) {
      var self = $module($base, 'Httpget');

      var $nesting = [self].concat($parent_nesting), $$ = Opal.$r($nesting);

      
      $klass($nesting[0], $$('StandardError'), 'Error');
      (function($base, $super) {
        var self = $klass($base, $super, 'Sender');

        
        
        self.$attr_reader("response_text");
        
        $def(self, '$initialize', $assign_ivar_val("response_text", nil), 0);
        return $def(self, '$get', function $$get(file) {
          var next_proc = $$get.$$p || nil, self = this, ans = nil;

          delete $$get.$$p;
          
          ;
          ans = "";
          
          // リクエスト定義
          var request = new XMLHttpRequest()
          request.open('GET', file, true)
          request.responseType = 'text'
    
          // ロード時は変数ansへ受け渡し
          request.onload = () =>  {
            ans = request.responseText
          }
    
          // ロード完了したらjsonパースして、画像をプリロード。そしてサイトのメインプログラム実行
          request.onloadend = () => {
            ((self.response_text = ans), Opal.yield1(next_proc, self))
          }
    
          // 読み込みエラー時の処理はここに書くらしいです
          request.onerror = () => {}
    
          request.send()
        ;
        }, 1);
      })($nesting[0], null);
      self.$module_function();
      
      $def(self, '$mypreload', function $$mypreload(files) {
        
        
        for(var i = 0; i< files.length; i++){
            $("<img>").attr("src", files[i]);
        }
      
      }, 1);
      return $def(self, '$preload_images', function $$preload_images(files) {
        var next_proc = $$preload_images.$$p || nil, $a, self = this, imnum = nil, targetnum = nil;

        delete $$preload_images.$$p;
        
        ;
        $a = [0, files.$length()], (imnum = $a[0]), (targetnum = $a[1]), $a;
        self.$mypreload(files);
        return Opal.yieldX(next_proc, []);;
      }, 1);
    })($nesting[0], $nesting)
  })($nesting[0], $nesting);
};

Opal.queue(function(Opal) {/* Generated by Opal 1.5.1 */
  var self = Opal.top, $nesting = [], $$ = Opal.$r($nesting), nil = Opal.nil, $$$ = Opal.$$$, $send = Opal.send;

  Opal.add_stubs('require,include,get,new,preload_images,puts,[]=,[]');
  
  self.$require("opal");
  self.$require("opal/httpget");
  self.$include($$$($$('Opal'), 'Httpget'));
  return $send($$('Sender').$new(), 'get', ["test.json"], function $$1(s){var self = $$1.$$s == null ? this : $$1.$$s;

    
    
    if (s == null) s = nil;;
    return $send(self, 'preload_images', [["test.jpg"]], function $$2(s2){var $a, self = $$2.$$s == null ? this : $$2.$$s;

      
      
      if (s2 == null) s2 = nil;;
      self.$puts("Finish loading image.");
      return ($a = ["src", "test.jpg"], $send($$('Element')['$[]'](".testimage"), '[]=', $a), $a[$a.length - 1]);}, {$$arity: 1, $$s: self});}, {$$arity: 1, $$s: self});
});
