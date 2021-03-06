'use strict';

var path   = require('path')
  , util   = require('util')
  , logger = require(path.join(__dirname, 'lib', 'logger')).child({component : 'api'})
  , NAMES  = require(path.join(__dirname, 'lib', 'metrics', 'names'))
  ;

/*
 *
 * CONSTANTS
 *
 */
var RUM_STUB = "<script type='text/javascript'>window.NREUM||(NREUM={});" +
                "NREUM.info = %s; %s</script>";

// these messages are used in the _gracefail() method below in getBrowserTimingHeader
var RUM_ISSUES = [
  'NREUM: no browser monitoring headers generated; disabled',
  'NREUM: transaction missing while generating browser monitoring headers',
  'NREUM: conf.browser_monitoring missing, something is probably wrong',
  'NREUM: browser_monitoring headers need a transaction name',
  'NREUM: browser_monitoring requires valid application_id',
  'NREUM: browser_monitoring requires valid browser_key'
];

function _rumObfuscate(string, license_key) {
  var bytes = new Buffer(string);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = bytes[i] ^ license_key[i % 13].charCodeAt(0);
  }
  return bytes.toString('base64');
}

/**
 * The exported New Relic API. This contains all of the functions meant to be
 * used by New Relic customers. For now, that means transaction naming.
 */
function API(agent) {
  this.agent = agent;
}

/**
 * Give the current transaction a custom name. Overrides any New Relic naming
 * rules set in configuration or from New Relic's servers.
 *
 * IMPORTANT: this function must be called when a transaction is active. New
 * Relic transactions are tied to web requests, so this method may be called
 * from within HTTP or HTTPS listener functions, Express routes, or other
 * contexts where a web request or response object are in scope.
 *
 * @param {string} name The name you want to give the web request in the New
 *                      Relic UI. Will be prefixed with 'Custom/' when sent.
 */
API.prototype.setTransactionName = function (name) {
  var transaction = this.agent.tracer.getTransaction();
  if (!transaction) {
    return logger.warn("No transaction found when setting name to '%s'.", name);
  }

  if (!name) {
    if (transaction && transaction.url) {
      logger.error("Must include name in setTransactionName call for URL %s.",
                   transaction.url);
    }
    else {
      logger.error("Must include name in setTransactionName call.");
    }

    return;
  }

  transaction.partialName = NAMES.CUSTOM + '/' + name;
};

/**
 * Give the current transaction a name based on your own idea of what
 * constitutes a controller in your Node application. Also allows you to
 * optionally specify the action being invoked on the controller. If the action
 * is omitted, then the API will default to using the HTTP method used in the
 * request (e.g. GET, POST, DELETE). Overrides any New Relic naming rules set
 * in configuration or from New Relic's servers.
 *
 * IMPORTANT: this function must be called when a transaction is active. New
 * Relic transactions are tied to web requests, so this method may be called
 * from within HTTP or HTTPS listener functions, Express routes, or other
 * contexts where a web request or response object are in scope.
 *
 * @param {string} name   The name you want to give the controller in the New
 *                        Relic UI. Will be prefixed with 'Controller/' when
 *                        sent.
 * @param {string} action The action being invoked on the controller. Defaults
 *                        to the HTTP method used for the request.
 */
API.prototype.setControllerName = function (name, action) {
  var transaction = this.agent.tracer.getTransaction();
  if (!transaction) {
    return logger.warn("No transaction found when setting controller to %s.", name);
  }

  if (!name) {
    if (transaction && transaction.url) {
      logger.error("Must include name in setControllerName call for URL %s.",
                   transaction.url);
    }
    else {
      logger.error("Must include name in setControllerName call.");
    }

    return;
  }

  action = action || transaction.verb || 'GET';
  transaction.partialName = NAMES.CONTROLLER + '/' + name + '/' + action;
};

/**
 * Tell the tracer whether to ignore the current transaction. The most common
 * use for this will be to mark a transaction as ignored (maybe it's handling
 * a websocket polling channel, or maybe it's an external call you don't care
 * is slow), but it's also useful when you want a transaction that would
 * otherwise be ignored due to URL or transaction name normalization rules
 * to *not* be ignored.
 *
 * @param {boolean} ignored Ignore, or don't ignore, the current transaction.
 */
API.prototype.setIgnoreTransaction = function (ignored) {
  var transaction = this.agent.tracer.getTransaction();
  if (!transaction) {
    return logger.warn("No transaction found to ignore.");
  }

  transaction.forceIgnore = ignored;
};

/**
 * Send errors to New Relic that you've already handled yourself. Should
 * be an Error or one of its subtypes, but the API will handle strings
 * and objects that have an attached .message or .stack property.
 *
 * @param {Error} error The error to be traced.
 */
API.prototype.noticeError = function (error) {
  var transaction = this.agent.tracer.getTransaction();
  this.agent.errors.add(transaction, error);
};

/**
 * If the URL for a transaction matches the provided pattern, name the
 * transaction with the provided name. If there are capture groups in the
 * pattern (which is a standard JavaScript regular expression, and can be
 * passed as either a RegExp or a string), then the substring matches ($1, $2,
 * etc.) are replaced in the name string. BE CAREFUL WHEN USING SUBSTITUTION.
 * If the replacement substrings are highly variable (i.e. are identifiers,
 * GUIDs, or timestamps), the rule will generate too many metrics and
 * potentially get your application blacklisted by New Relic.
 *
 * An example of a good rule with replacements:
 *
 *   newrelic.addNamingRule('^/storefront/(v[1-5])/(item|category|tag)',
 *                          'CommerceAPI/$1/$2')
 *
 * An example of a bad rule with replacements:
 *
 *   newrelic.addNamingRule('^/item/([0-9a-f]+)', 'Item/$1')
 *
 * Keep in mind that the original URL and any query parameters will be sent
 * along with the request, so slow transactions will still be identifiable.
 *
 * Naming rules can not be removed once added. They can also be added via the
 * agent's configuration. See configuration documentation for details.
 *
 * @param {RegExp} pattern The pattern to rename (with capture groups).
 * @param {string} name    The name to use for the transaction.
 */
API.prototype.addNamingRule = function (pattern, name) {
  if (!name) return logger.error("Simple naming rules require a replacement name.");

  this.agent.userNormalizer.addSimple(pattern, '/' + name);
};

/**
 * If the URL for a transaction matches the provided pattern, ignore the
 * transaction attached to that URL. Useful for filtering socket.io connections
 * and other long-polling requests out of your agents to keep them from
 * distorting an app's apdex or mean response time. Pattern may be a (standard
 * JavaScript) RegExp or a string.
 *
 * Example:
 *
 *   newrelic.addIgnoringRule('^/socket\\.io/')
 *
 * @param {RegExp} pattern The pattern to ignore.
 */
API.prototype.addIgnoringRule = function (pattern) {
  if (!pattern) return logger.error("Must include a URL pattern to ignore.");

  this.agent.userNormalizer.addSimple(pattern, null);
};

/**
 * Get the <script>...</script> header necessary for Browser Monitoring
 * This script must be manually injected into your templates, as high as possible
 * in the header, but _after_ any X-UA-COMPATIBLE HTTP-EQUIV meta tags.
 * Otherwise you may hurt IE!
 *
 * This method must be called _during_ a transaction, and must be called every
 * time you want to generate the headers.
 *
 * Do *not* reuse the headers between users, or even between requests.
 *
 * @returns {string} the <script> header to be injected
 */
API.prototype.getBrowserTimingHeader = function () {
  var conf = this.agent.config;

  /* Gracefully fail.
   *
   * Output an HTML comment and log a warning the comment is meant to be
   * innocuous to the end user.
   */
  function _gracefail(num){
    logger.warn(RUM_ISSUES[num]);
    return '<!-- NREUM: (' + num + ') -->';
  }

  var browser_monitoring = conf.browser_monitoring;

  // conf.browser_monitoring should always exist, but we don't want the agent to bail
  // here if something goes wrong
  if (!browser_monitoring) return _gracefail(2);

  /* Can control header generation with configuration this setting is only
   * available in the newrelic.js config file, it is not ever set by the
   * server.
   */
  if (!browser_monitoring.enable) return _gracefail(0);

  var trans = this.agent.getTransaction();

  // bail gracefully outside a transaction
  if (!trans) return _gracefail(1);

  var name = trans.partialName;

  /* If we're in an unnamed transaction, add a friendly warning this is to
   * avoid people going crazy, trying to figure out why browser monitoring is
   * not working when they're missing a transaction name.
   */
  if (!name) return _gracefail(3);

  var time  = trans.timer.getDurationInMillis();
  var key   = conf.license_key;
  var appid = conf.application_id;

  /* This is only going to work if the agent has successfully handshaked with
   * the collector. If the networks is bad, or there is no license key set in
   * newrelis.js, there will be no application_id set.  We bail instead of
   * outputting null/undefined configuration values.
   */
  if (!appid) return _gracefail(4);

  /* If there is no browser_key, the server has likely decided to disable
   * browser monitoring.
   */
  var licenseKey = browser_monitoring.browser_key;
  if (!licenseKey) return _gracefail(5);

  // This hash gets written directly into the browser.
  var rum_hash = {
    agent           : browser_monitoring.js_agent_file,
    beacon          : browser_monitoring.beacon,
    errorBeacon     : browser_monitoring.error_beacon,
    licenseKey      : licenseKey,
    applicationID   : appid,
    applicationTime : time,
    transactionName : _rumObfuscate(name, key),
    queueTime       : trans.queueTime,

    // we don't use these parameters yet
    agentToken      : null,
    ttGuid          : ""
  };

  // if debugging, do pretty format of JSON
  var tabs = conf.browser_monitoring.debug ? 2 : 0
    , json = JSON.stringify(rum_hash, null, tabs)
    ;

  // the complete header to be written to the browser
  var out = util.format(
    RUM_STUB,
    json,
    browser_monitoring.js_agent_loader
  );

  logger.trace('generating RUM header', out);

  return out;
};

module.exports = API;
