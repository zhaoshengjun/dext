const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const plist = require('plist');
const deepAssign = require('deep-assign');
const is = require('is_js');
const MarkdownIt = require('markdown-it');
const { PLUGIN_PATH } = require('../../utils/paths');
const { MAX_RESULTS } = require('../constants');

// @TODO: Move to a `constants` file
const isDev = process.env.NODE_ENV === 'development';

/**
 * Loads plugins in the given path
 *
 * @param {String} directory - The directory to read
 * @return {Promise} - An array of plugin paths
 */
exports.loadPluginsInPath = directory => new Promise((resolve) => {
  const loaded = [];
  fs.readdir(directory, (err, plugins) => {
    if (plugins && plugins.length) {
      plugins.forEach((plugin) => {
        if (plugin !== '.DS_Store') {
          const pluginPath = path.resolve(directory, plugin);
          loaded.push(pluginPath);
        }
      });
    }
    resolve(loaded);
  });
});

/**
 * Checks to see if a plugin is a core plugin.
 * (Lives inside the core plugin path)
 *
 * @param
 */
exports.isCorePlugin = (directory) => {
  const dirname = path.dirname(directory);
  if (dirname === PLUGIN_PATH) {
    return false;
  }
  return true;
};

/**
 * Checks if the plugin is a theme
 *
 * @param {String} directory - A plugin directory
 * @return {Boolean} - True if it is a theme
 */
exports.isPluginATheme = (directory) => {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const pkg = require(path.resolve(directory, 'package.json'));
    // TODO: change the mechanism?
    // don't load themes by checking if dext-theme is non-existent in keywords
    if (!pkg.keywords || pkg.keywords.indexOf('dext-theme') > -1) {
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
};

/**
 * Applies the module properties by loading them.
 * Loads the plugin's Alfred plist file if available.
 * Modifies the schema property if the plugin is an Alfred plugin.
 *
 * plugin { path, name, isCore, schema, keyword, action, helper }
 *
 * @param {String} plugin - The plugin object
 * @return {Promise} - A modified clone of the plugin object
 */
exports.applyModuleProperties = plugin => new Promise((resolve) => {
  const plistPath = path.resolve(plugin.path, 'info.plist');
  fs.access(plistPath, fs.constants.R_OK, (err1) => {
    if (err1) {
      // retrieve the keyword and action from the plugin
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { keyword, action, helper } = require(plugin.path);
      // set the plugin object overrides
      const newOpts = {
        schema: 'dext',
        action,
        keyword,
        helper,
      };
      resolve(deepAssign({}, plugin, newOpts));
    } else {
      // read the plist file
      fs.readFile(plistPath, 'utf8', (err2, data) => {
        if (err2) {
          resolve(plugin);
        } else {
          // parse the plist
          const plistData = plist.parse(data);
          let keyword = '';
          let action = '';
          plistData.objects.forEach((o) => {
            if (o.type === 'alfred.workflow.input.scriptfilter') {
              keyword = o.config.keyword;
            } else if (o.type === 'alfred.workflow.action.openurl') {
              action = 'openurl';
            }
          });
          // set the plugin object overrides
          const newOpts = {
            schema: 'alfred',
            action,
            keyword,
          };
          resolve(deepAssign({}, plugin, newOpts));
        }
      });
    }
  });
});

/**
 * Loads all plugins from the given set of
 * directories and apply module properties.
 *
 * @param {String[]} directories - An array of directories to load
 * @return {Promise} - Resolves a list of plugin objects
 */
exports.loadPlugins = directories => new Promise((resolve) => {
  const prom = directories.map(exports.loadPluginsInPath);
  Promise.all(prom)
    .then((pluginSets) => {
      const allPlugins = pluginSets
        // merge promise results
        .reduce((a, b) => a.concat(b))
        // turn into array of objects
        .map(plugin => ({
          path: plugin,
          name: path.basename(plugin),
          isCore: exports.isCorePlugin(plugin),
          schema: 'dext',
          action: 'openurl',
          keyword: '',
        }))
        .filter(plugin => !exports.isPluginATheme(plugin.path));
      // check for Alfred plugins in the user
      // if it is an Alfred plugin, set the schema
      const ready = allPlugins.map(exports.applyModuleProperties);
      Promise.all(ready).then(resolve);
    });
});

/**
 * Connects the item sets with the given plugin
 *
 * plugin { path, name, isCore, schema, keyword, action, helper }
 *
 * @param {Object[]} items - An array of items
 * @param {Object} plugin - The plugin object data
 * @return {Object}
 */
exports.connectItems = (items, plugin) => items.map((i) => {
  const icon = {
    path: '',
  };
  if (i.icon && i.icon.path) {
    icon.path = i.icon.path;
    // resolve non-urls
    if (!is.url(i.icon.path)) {
      icon.path = path.resolve(plugin.path, i.icon.path);
    }
  }
  const newObject = deepAssign({}, i);
  // transfer some plugin metadata
  newObject.plugin = {
    path: plugin.path,
    name: plugin.name,
  };
  if (plugin.keyword) {
    newObject.keyword = plugin.keyword;
  }
  if (plugin.action) {
    newObject.action = plugin.action;
  }
  if (icon.path) {
    newObject.icon.path = icon.path;
  }
  return newObject;
});

/**
 * Queries for the items in the given plugin
 *
 * plugin { path, name, isCore, schema, keyword, action, helper }
 *
 * @param {Object} plugin - The plugin object
 * @param {String[]} args - An array of arguments
 * @return {Promise} - An array of results
 */
exports.queryResults = (plugin, args) => new Promise((resolve) => {
  const query = args.join(' ');
  // process based on the schema
  switch (plugin.schema) {
    case 'alfred': {
      // fork a child process to receive all stdout
      // and concat it to the results array
      const options = {
        cwd: plugin.path,
        silent: true,
      };
      const child = fork(plugin.path, args, options);
      let msg = '';
      child.stdout.on('data', (data) => {
        if (data) {
          msg += data.toString();
        }
      });
      child.on('exit', () => {
        let items = [];
        if (msg.length) {
          const output = JSON.parse(msg);
          if (output) {
            items = exports.connectItems(output.items, plugin);
          }
        }
        resolve(items);
      });
      break;
    }
    case 'dext':
      // no break
    default: { // eslint-disable-line no-fallthrough
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const pluginObj = require(plugin.path);

      // The new API:
      // - `query`: querying the plugin with arguments
      // - `execute`: executing the specific item
      const isOutdatedPlugin = Boolean(pluginObj && pluginObj.execute);
      const queryCommand = isOutdatedPlugin ? 'execute' : 'query';
      const command = pluginObj[queryCommand];
      const output = (typeof command === 'function')
        ? command(query, { size: MAX_RESULTS })
        : command;

      if (output) {
        if (isDev && isOutdatedPlugin) {
          console.log(`
            Plugin is outdated.
            Please update the plugin accordingly to the new API.
            @see https://github.com/vutran/dext/issues/52 for reference.
          `);
        }

        Promise.resolve(output).then((i) => {
          const items = exports.connectItems(i.items, plugin);
          resolve(items);
        });
      } else {
        resolve([]);
      }
      break;
    }
  }
});

/**
 * Retrieve helper items
 *
 * plugin { path, name, isCore, schema, keyword, action, helper }
 *
 * @param {Object} plugin - The plugin object
 * @param {String[]} keyword - The query keyword
 * @return {Promise} - An array of results
 */
exports.queryHelper = (plugin, keyword) => new Promise((resolve) => {
  let items = [];
  if (!plugin.helper) {
    resolve(items);
    return;
  }
  let helperItem = plugin.helper;
  // retrieve the helper item call if it's
  // a function and resolve as necessary
  if (typeof plugin.helper === 'function') {
    helperItem = plugin.helper(keyword);
  }
  Promise.resolve(helperItem).then((item) => {
    items.push(item);
    items = exports.connectItems(items, plugin);
    resolve(items);
  });
});

/**
 * Retrieve the item's details
 *
 * plugin { path, name, isCore, schema, keyword, action, helper }
 *
 * @cached
 * @param {Object} item
 * @param {Object} plugin - The plugin object
 * @return {Promise} - Resolves to the rendered html string
 */
exports.retrieveItemDetails = (item, plugin) => new Promise((resolve) => {
  // retrieve the rendered content
  let type = 'html';
  let content = '';
  if (plugin && plugin.details) {
    if (plugin.details.type) {
      type = plugin.details.type;
    }
    if (plugin.details.render) {
      if (typeof plugin.details.render === 'function') {
        content = plugin.details.render(item);
      } else {
        content = plugin.details.render;
      }
    }
  }
  // resolve and update the state
  Promise.resolve(content).then((res) => {
    let html = res;
    if (type === 'md') {
      const md = new MarkdownIt();
      html = md.render(res);
    }
    resolve(html);
  });
});
