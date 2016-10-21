/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2016 Center for History and New Media
					George Mason University, Fairfax, Virginia, USA
					http://zotero.org
	
	This file is part of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

(function() {

"use strict";

var url = require('url');

/**
 * A singleton to handle URL rewriting proxies
 * @namespace
 * @property transparent {Boolean} Whether transparent proxy functionality is enabled
 * @property proxies {Zotero.Proxy[]} All loaded proxies
 * @property hosts {Zotero.Proxy{}} Object mapping hosts to proxies
 */
Zotero.Proxies = new function() {
	this.transparent = false;
	this.proxies = [];
	this.hosts = {};
	this._reqIDToHeaders = {};
	this._ignoreURLs = new Set();

	/**
	 * Initializes the proxy settings
	 * @returns Promise{boolean} proxy enabled/disabled status
	 */
	this.init = function () {
		// If transparent is true, we have loaded the settings from standalone already
		Zotero.Proxies.transparent = Zotero.Prefs.get("proxies.transparent");
		Zotero.Proxies.autoRecognize = Zotero.Proxies.transparent && Zotero.Prefs.get("proxies.autoRecognize");
		
		var disableByDomainPref = Zotero.Prefs.get("proxies.disableByDomain");
		Zotero.Proxies.disableByDomain = (Zotero.Proxies.transparent && disableByDomainPref ? Zotero.Prefs.get("proxies.disableByDomainString") : null);
		Zotero.Proxies.showRedirectNotification = Zotero.Prefs.get("proxies.showRedirectNotification");
		
		Zotero.Proxies.lastIPCheck = 0;
		Zotero.Proxies.disabledByDomain = false;
		
		Zotero.Proxies.proxies = Zotero.Prefs.get('proxies.proxies').map(function(proxy) {
			proxy = Zotero.Proxies.newProxyFromJSON(proxy);
			for (let host of proxy.hosts) {
				Zotero.Proxies.hosts[host] = proxy;
			}
			return proxy;
		});

		if (this.transparent) {
			this.enable();
			this.updateDisabledByDomain();
		}
	};
	
	
	this.enable = function() {
		chrome.webRequest.onBeforeSendHeaders.addListener(this.storeRequestHeaders.bind(this), {urls: ['<all_urls>']}, ['requestHeaders']);
		chrome.webRequest.onErrorOccurred.addListener(this.removeRequestHeaders.bind(this), {urls: ['<all_urls>']});
		chrome.webRequest.onCompleted.addListener(this.removeRequestHeaders.bind(this), {urls: ['<all_urls>']});
		chrome.webRequest.onHeadersReceived.addListener(this.observe.bind(this), {urls: ['<all_urls>']}, ['blocking', 'responseHeaders']);
	};
	
	
	this.disable = function() {
		this._reqIDToHeaders = {};
		chrome.webRequests.onBeforeSendHeaders.removeListener(this.storeRequestHeaders);
		chrome.webRequest.onErrorOccurred.removeListener(this.removeRequestHeaders);
		chrome.webRequest.onCompleted.removeListener(this.removeRequestHeaders);
		chrome.webRequests.onHeadersReceived.removeListener(this.observe);
	};
	
	
	this.updateDisabledByDomain = function() {
		let now = Date.now();
		if (now - this.lastIPCheck > 15 * 60 * 1000) {
			Zotero.Proxies.DNS.getHostnames().then(function(hosts) {
				// if domains necessitate disabling, disable them
				Zotero.Proxies.disabledByDomain = false;
				for (var host of hosts) {
					Zotero.Proxies.disabledByDomain = host.toLowerCase().indexOf(Zotero.Proxies.disableByDomain) != -1;
					if (Zotero.Proxies.disabledByDomain) return;
				}
				
				// IP update interval is every 15 minutes
				this.lastIPCheck = now;
			}.bind(this));
		}
	};
	
	
	this.storeRequestHeaders = function(details) {
		this._reqIDToHeaders[details.requestID] = _processHeaders(details.requestHeaders);
	};
	
	this.removeRequestHeaders = function(details) {
		delete this._reqIDToHeaders[details.requestID];
	};
	

	/**
	 * @param {Object} json - JSON object with proxy data
	 * @return {Zotero.Proxy}
	 */
	this.newProxyFromJSON = function (json) {
		var proxy = new Zotero.Proxy;
		proxy.loadFromJSON(json);
		return proxy;
	};


	/**
	 * Observe method to capture and redirect page loads if they're going through an existing proxy.
	 *
	 * @param {Object} details - webRequest details object
	 */
	this.observe = function (details) {
		if (this._ignoreURLs.has(details.url) || details.statusCode >= 400) {
			return;
		}
		// try to detect a proxy
		var requestURL = details.url;
		var requestURI = url.parse(requestURL);

		// see if there is a proxy we already know
		var m = false;
		for (var proxy of  Zotero.Proxies.proxies) {
			if (proxy.regexp && proxy.multiHost) {
				m = proxy.regexp.exec(requestURL);
				if (m) break;
			}
		}

		if (m) {
			var host = m[proxy.parameters.indexOf("%h")+1];
			// add this host if we know a proxy
			if (proxy.autoAssociate							// if autoAssociate is on
				&& details.statusCode < 400					// and query was successful
				&& !Zotero.Proxies.hosts[host]				// and host is not saved
				&& proxy.hosts.indexOf(host) === -1
				&& !_isBlacklisted(host)					// and host is not blacklisted
			) {
				proxy.hosts.push(host);
				Zotero.Proxies.save(proxy);

				_showNotification(`Zotero automatically associated this site with a previously defined proxy. Future requests to ${host} will be redirected to ${requestURI.host}.`);
			}
		} else if (Zotero.Proxies.autoRecognize) {
			// if autoRecognize enabled, send the request details off to standalone to try and detect a proxy
			// perform in the next event loop step to reduce impact of header processing in a blocking call
			setTimeout(function() {
				details.responseHeaders = _processHeaders(details.responseHeaders);
				details.requestHeaders = Zotero.Proxies._reqIDToHeaders[details.requestID];
				
				var proxy = false;
				for (var detectorName in Zotero.Proxies.Detectors) {
					var detector = Zotero.Proxies.Detectors[detectorName];
					try {
						proxy = detector(details);
					} catch(e) {
						Zotero.logError(e);
					}
					
					if (!proxy) continue;
					Zotero.debug("Proxies: Detected "+detectorName+" proxy "+proxy.scheme+
						(proxy.multiHost ? " (multi-host)" : " for "+proxy.hosts[0]));
					
					_showNotification(
						`Zotero detected that you are accessing this website through a proxy. Would you like to automatically redirect future requests to ${proxy.hosts[0]} through ${requestURI.host}`
					);
					
					Zotero.Proxies.save(proxy);
					
					break;
				}
			});
		}

		Zotero.Proxies.updateDisabledByDomain();
		if (Zotero.Proxies.disabledByDomain) return;

		var proxied = Zotero.Proxies.properToProxy(requestURL, true);
		if (!proxied) return;

		details.requestHeaders = Zotero.Proxies._reqIDToHeaders[details.requestID];
		details.responseHeaders = _processHeaders(details.responseHeaders);
		return _maybeRedirect(details, proxied);
	};

	function _maybeRedirect(details, proxied) {
		var proxiedURI = url.parse(proxied);
		if (details.requestHeaders['referer']) {
			// If the referrer is a proxiable host, we already have access (e.g., we're
			// on-campus) and shouldn't redirect
			if (Zotero.Proxies.properToProxy(details.requestHeaders['referer'], true)) {
				Zotero.debug("Proxies: skipping redirect; referrer was proxiable");
				return;
			}
			// If the referrer is the same host as we're about to redirect to, we shouldn't
			// or we risk a loop
			if (url.parse(details.requestHeaders['referer']).hostname == proxiedURI.hostname) {
				Zotero.debug("Proxies: skipping redirect; redirect URI and referrer have same host");
				return;
			}
		}

		if (details.originUrl) {
			// If the original URI was a proxied host, we also shouldn't redirect, since any
			// links handed out by the proxy should already be proxied
			if (Zotero.Proxies.proxyToProper(details.originUrl, true)) {
				Zotero.debug("Proxies: skipping redirect; original URI was proxied");
				return;
			}
			// Finally, if the original URI is the same as the host we're about to redirect
			// to, then we also risk a loop
			if (url.parse(details.originUrl).hostname == proxiedURI.hostname) {
				Zotero.debug("Proxies: skipping redirect; redirect URI and original URI have same host");
				return;
			}
		}

		// make sure that the top two domains (e.g. gmu.edu in foo.bar.gmu.edu) of the
		// channel and the site to which we're redirecting don't match, to prevent loops.
		const top2DomainsRe = /[^\.]+\.[^\.]+$/;
		let top21 = top2DomainsRe.exec(url.parse(details.url).hostname);
		let top22 = top2DomainsRe.exec(proxiedURI.hostname);
		if (!top21 || !top22 || top21[0] == top22[0]) {
			Zotero.debug("Proxies: skipping redirect; redirect URI and URI have same top 2 domains");
			return;
		}

		// Otherwise, redirect.
		if (Zotero.Proxies.showRedirectNotification) {
			// TODO: allow disabling notifications
			_showNotification(`Zotero automatically redirected your request to ${url.parse(details.url).host} through the proxy at ${proxiedURI.host}.`);
		}
			
		return {redirectUrl: proxied};
	}


	/**
	 * Update proxy and host maps and store proxy settings in storage
	 */
	this.save = function(proxy) {
		if (Zotero.Proxies.proxies.indexOf(proxy) == -1) Zotero.Proxies.proxies.push(proxy);
		if (!proxy.regexp) proxy.compileRegexp();

		// delete hosts that point to this proxy if they no longer exist
		for (let host in Zotero.Proxies.hosts) {
			if (Zotero.Proxies.hosts[host] == proxy && proxy.hosts.indexOf(host) == -1) {
				delete Zotero.Proxies.hosts[host];
			}
		}
		
		for (let host of proxy.hosts) {
			Zotero.Proxies.hosts[host] = proxy;
		}
		
		let proxies = Zotero.Proxies.proxies.map(function(proxy) {
			return {
				multiHost: proxy.multiHost, 
				autoAssociate: proxy.autoAssociate,
				scheme: proxy.scheme,
				hosts: proxy.hosts
			};
		});
		
		Zotero.Prefs.set('proxies.proxies', proxies);
	};

	/**
	 * Returns a page's proper URL from a proxied URL. Uses both transparent and opaque proxies.
	 * @param {String} URL
	 * @param {Boolean} onlyReturnIfProxied Controls behavior if the given URL is not proxied. If
	 *	it is false or unspecified, unproxied URLs are returned verbatim. If it is true, the
	 *	function will return "false" if the given URL is unproxied.
	 * @type String
	 */
	this.proxyToProper = function(URL, onlyReturnIfProxied) {
		for (var proxy of Zotero.Proxies.proxies) {
			if (proxy.regexp) {
				var m = proxy.regexp.exec(URL);
				if (m) {
					var toProper = proxy.toProper(m);
					Zotero.debug("Proxies.proxyToProper: "+URL+" to "+toProper);
					return toProper;
				}
			}
		}
		return (onlyReturnIfProxied ? false : URL);
	};

	/**
	 * Returns a page's proxied URL from the proper URL. Uses only transparent proxies.
	 * @param {String} URL
	 * @param {Boolean} onlyReturnIfProxied Controls behavior if the given URL is not proxied. If
	 *	it is false or unspecified, unproxied URLs are returned verbatim. If it is true, the
	 *	function will return "false" if the given URL is unproxied.
	 * @type String
	 */
	this.properToProxy = function(URL, onlyReturnIfProxied) {
		var uri = url.parse(URL);
		if (Zotero.Proxies.hosts[uri.host]) {
			var toProxy = Zotero.Proxies.hosts[uri.host].toProxy(uri);
			Zotero.debug("Proxies.properToProxy: "+URL+" to "+toProxy);
			return toProxy;
		}
		return (onlyReturnIfProxied ? false : URL);
	};

	/**
	 * Determines whether a host is blacklisted, i.e., whether we should refuse to save transparent
	 * proxy entries for this host. This is necessary because EZProxy offers to proxy all Google and
	 * Wikipedia subdomains, but in practice, this would get really annoying.
	 *
	 * @type Boolean
	 * @private
	 */
	function _isBlacklisted(host) {
		/**
		 * Regular expression patterns of hosts never to proxy
		 * @const
		 */
		const hostBlacklist = [
			/edu$/,
			/google\.com$/,
			/wikipedia\.org$/,
			/^[^.]*$/,
			/doubleclick\.net$/
		];
		/**
		 * Regular expression patterns of hosts that should always be proxied, regardless of whether
		 * they're on the blacklist
		 * @const
		 */
		const hostWhitelist = [
			/^scholar\.google\.com$/,
			/^muse\.jhu\.edu$/
		]

		for (var blackPattern of hostBlacklist) {
			if (blackPattern.test(host)) {
				for (var whitePattern of hostWhitelist) {
					if (whitePattern.test(host)) {
						return false;
					}
				}
				return true;
			}
		}
		return false;
	}

	/**
	 * Show a proxy-related notification
	 * @param {String} label - notification text
	 */
	function _showNotification(label) {
		// Get localized button labels
		Zotero.debug(`NOTIFICATION: ${label}`)
	};

	/**
	 * Convert from webRequest.HttpHeaders array to a lowercased object.
	 * 
	 * headers = _processHeaders(details.requestHeaders)
	 * console.log(headers['accept-charset']) // utf-8
	 * 
	 * @param {Array} headerArray
	 * @return {Object} headers
	 */
	function _processHeaders(headerArray) {
		if (! Array.isArray(headerArray)) return headerArray;
		
		let headers = {};
		for (let header of headerArray) {
			headers[header.name.toLowerCase()] = header.value;
		}
		return headers;
	};
};

/**
 * Creates a Zotero.Proxy object from a DB row
 *
 * @constructor
 * @class Represents an individual proxy server
 */
Zotero.Proxy = function () {
	this.hosts = [];
	this.multiHost = false;
}

/**
 * Regexps to match the URL contents corresponding to proxy scheme parameters
 * @const
 */
const Zotero_Proxy_schemeParameters = {
	"%p":"(.*?)",	// path
	"%d":"(.*?)",	// directory
	"%f":"(.*?)",	// filename
	"%a":"(.*?)"	// anything
};

/**
 * Regexps to match proxy scheme parameters in the proxy scheme URL
 * @const
 */
const Zotero_Proxy_schemeParameterRegexps = {
	"%p":/([^%])%p/,
	"%d":/([^%])%d/,
	"%f":/([^%])%f/,
	"%h":/([^%])%h/,
	"%a":/([^%])%a/
};

/**
 * Compiles the regular expression against which we match URLs to determine if this proxy is in use
 * and saves it in this.regexp
 */
Zotero.Proxy.prototype.compileRegexp = function() {
	// take host only if flagged as multiHost
	var parametersToCheck = Zotero_Proxy_schemeParameters;
	if (this.multiHost) parametersToCheck["%h"] = "([a-zA-Z0-9]+\\.[a-zA-Z0-9\.]+)";

	var indices = this.indices = {};
	this.parameters = [];
	for(var param in parametersToCheck) {
		var index = this.scheme.indexOf(param);

		// avoid escaped matches
		while(this.scheme[index-1] && (this.scheme[index-1] == "%")) {
			this.scheme = this.scheme.substr(0, index-1)+this.scheme.substr(index);
			index = this.scheme.indexOf(param, index+1);
		}

		if (index != -1) {
			this.indices[param] = index;
			this.parameters.push(param);
		}
	}

	// sort params by index
	this.parameters = this.parameters.sort(function(a, b) {
		return indices[a]-indices[b];
	})

	// now replace with regexp fragment in reverse order
	var re = "^"+Zotero.Utilities.quotemeta(this.scheme)+"$";
	for(var i=this.parameters.length-1; i>=0; i--) {
		var param = this.parameters[i];
		re = re.replace(Zotero_Proxy_schemeParameterRegexps[param], "$1"+parametersToCheck[param]);
	}

	this.regexp = new RegExp(re);
}

/**
 * Converts a proxied URL to an unproxied URL using this proxy
 *
 * @param m {Array} The match from running this proxy's regexp against a URL spec
 * @type String
 */
Zotero.Proxy.prototype.toProper = function(m) {
	if (this.multiHost) {
		var properURL = "http://"+m[this.parameters.indexOf("%h")+1]+"/";
	} else {
		var properURL = "http://"+this.hosts[0]+"/";
	}

	if (this.indices["%p"]) {
		properURL += m[this.parameters.indexOf("%p")+1];
	} else {
		var dir = m[this.parameters.indexOf("%d")+1];
		var file = m[this.parameters.indexOf("%f")+1];
		if (dir !== "") properURL += dir+"/";
		properURL += file;
	}

	return properURL;
}

/**
 * Converts an unproxied URL to a proxied URL using this proxy
 *
 * @param {Object} uri The URI corresponding to the unproxied URL
 * @type String
 */
Zotero.Proxy.prototype.toProxy = function(uri) {
	var proxyURL = this.scheme;

	for(var i=this.parameters.length-1; i>=0; i--) {
		var param = this.parameters[i];
		var value = "";
		if (param == "%h") {
			value = uri.host;
		} else if (param == "%p") {
			value = uri.path.substr(1);
		} else if (param == "%d") {
			value = uri.path.substr(0, uri.path.lastIndexOf("/"));
		} else if (param == "%f") {
			value = uri.path.substr(uri.path.lastIndexOf("/")+1)
		}

		proxyURL = proxyURL.substr(0, this.indices[param])+value+proxyURL.substr(this.indices[param]+2);
	}

	return proxyURL;
}

/**
 * Loads a proxy object from a JSON object
 */
Zotero.Proxy.prototype.loadFromJSON = function (json) {
	this.multiHost = !!json.multiHost;
	this.autoAssociate = !!json.autoAssociate;
	this.scheme = json.scheme;
	this.hosts = json.hosts;
	this.compileRegexp();
};

/**
 * Detectors for various proxy systems
 * @namespace
 */
Zotero.Proxies.Detectors = {};

/**
 * Detector for OCLC EZProxy
 * @param {Object} details
 * @type Boolean|Zotero.Proxy
 */
Zotero.Proxies.Detectors.EZProxy = function(details) {
	// Try to catch links from one proxy-by-port site to another
	var uri = url.parse(details.url);
	if (! uri.port || [80, 443].indexOf(uri.port) == -1) {
		// Two options here: we could have a redirect from an EZProxy site to another, or a link
		// If it's a redirect, we'll have to catch the Location: header
		var toProxy = false;
		var fromProxy = false;
		if ([301, 302, 303].indexOf(details.statusCode) !== -1) {
			try {
				toProxy = url.parse(details.responseHeaders["location"]);
				fromProxy = uri;
			} catch(e) {}
		} else {
			try {
				toProxy = uri;
				fromProxy = url.parse(details.responseHeaders["referer"]);
			} catch (e) {}
		}
		
		if (fromProxy && toProxy && fromProxy.hostname == toProxy.hostname && fromProxy.port != toProxy.port
				&& (! toProxy.port || [80, 443].indexOf(toProxy.port) == -1)) {
			for (var proxy of Zotero.Proxies.proxies) {
				if (proxy.regexp) {
					var m = proxy.regexp.exec(fromProxy.href);
					if (m) break;
				}
			}
			if (m) {
				// Make sure caught proxy is not multi-host and that we don't have this new proxy already
				if (proxy.multiHost || Zotero.Proxies.proxyToProper(toProxy.href, true)) return false;
				
				Zotero.debug("Proxies: Identified putative port-by-port EZProxy link from "+fromProxy.host+" to "+toProxy.host);

				// Figure out real URL by failing to send cookies, so we get back to the login page
				new Zotero.Proxies.Detectors.EZProxy.Listener(toProxy.href);
				let xhr = new XMLHttpRequest;
				xhr.open('GET', toProxy.href, true);
				xhr.send();
				
				return false;
			}
		}
	}
	
	// Now try to catch redirects
	try {
		var proxiedURI = url.parse(details.responseHeaders["location"]);
	} catch (e) {
		return false;
	}
	if (!proxiedURI.protocol || details.statusCode != 302 || details.responseHeaders["server"] != "EZproxy") return false;
	return Zotero.Proxies.Detectors.EZProxy.learn(url.parse(details.url), proxiedURI);
}

/**
 * Learn about a mapping from an EZProxy to a normal proxy
 * @param {nsIURI} loginURI The URL of the login page
 * @param {nsIURI} proxiedURI The URI of the page
 * @return {Zotero.Proxy | false}
 */
Zotero.Proxies.Detectors.EZProxy.learn = function(loginURI, proxiedURI) {
	// look for query
	var m =  /(url|qurl)=([^&]+)/i.exec(loginURI.query);
	if (!m) return false;
	
	// Ignore if we already know about it
	if (Zotero.Proxies.proxyToProper(proxiedURI.href, true)) return false;
	
	// Found URL
	var properURL = (m[1].toLowerCase() == "qurl" ? decodeURI(m[2]) : m[2]);
	var properURI = url.parse(properURL);
	if (!properURI.protocol) {
		return false;
	}
	
	var proxy = false;
	if (loginURI.hostname == proxiedURI.hostname && (!proxiedURI.port || [loginURI.port, 80, 443].indexOf(proxiedURI.port) == -1)) {
		// Proxy by port
		proxy = new Zotero.Proxy();
		proxy.multiHost = false;
		proxy.scheme = proxiedURI.protocol+"//"+proxiedURI.host+"/%p";
		proxy.hosts = [properURI.host];
	} else if (proxiedURI.hostname != loginURI.hostname && proxiedURI.host.indexOf(properURI.hostname) != -1) {
		// Proxy by host
		proxy = new Zotero.Proxy();
		proxy.multiHost = proxy.autoAssociate = true;
		proxy.scheme = proxiedURI.protocol+"//"+proxiedURI.host.replace(properURI.hostname, "%h")+"/%p";
		proxy.hosts = [properURI.host];
	}
	return proxy;
}

/**
 * @class Observer to clear cookies on an HTTP request, then remove itself
 */
Zotero.Proxies.Detectors.EZProxy.Listener = function(requestURL) {
	Zotero.Proxies._ignoreURLs.add(requestURL);
	chrome.webRequest.onBeforeSendHeaders.addListener(this.onBeforeSendHeaders.bind(this), {urls: [requestURL]}, ['blocking']);
	chrome.webRequest.onHeadersReceived.addListener(this.onHeadersReceived.bind(this), {urls: [requestURL]}, ['blocking', 'responseHeaders']);
	chrome.webRequest.onErrorOccurred.addListener(this.deregister.bind(this, [requestURL]), {urls: [requestURL]});
};
Zotero.Proxies.Detectors.EZProxy.Listener.prototype.deregister = function(requestURL) {
	Zotero.Proxies._ignoreURLs.delete(requestURL);
	chrome.webRequest.onBeforeSendHeaders.removeListener(this.onBeforeSendHeaders);
	chrome.webRequest.onHeadersReceived.removeListener(this.onHeadersReceived);
	chrome.webRequest.onErrorOccurred.removeListener(this.deregister);
};
Zotero.Proxies.Detectors.EZProxy.Listener.prototype.onBeforeSendHeaders = function(details) {
	return {requestHeaders: details.requestHeaders.filter((header) => header.name.toLowerCase != 'cookie')}
};
Zotero.Proxies.Detectors.EZProxy.Listener.prototype.onHeadersReceived = function(details) {
	// Make sure this is a redirect involving an EZProxy
	try {
		var loginURI = url.parse(details.responseHeaders["location"]);
	} catch (e) {
		return false;
	}
	if (!loginURI.protocol || details.statusCode != 302 || details.responseHeaders["server"] != "EZproxy") return false;

	var proxy = Zotero.Proxies.Detectors.EZProxy.learn(url.parse(loginURI), url.parse(details.url));
	if (proxy) {
		Zotero.debug("Proxies: Proxy-by-port EZProxy "+aSubject.URI.hostPort+" corresponds to "+proxy.hosts[0]);
		Zotero.Proxies.save(proxy);
	}
	this.deregister();
	return {cancel: true};
};

/**
 * Detector for Juniper Networks WebVPN
 * @param {Object} details
 * @type Boolean|Zotero.Proxy
 */
Zotero.Proxies.Detectors.Juniper = function(details) {
	const juniperRe = /^(https?:\/\/[^\/:]+(?:\:[0-9]+)?)\/(.*),DanaInfo=([^+,]*)([^+]*)(?:\+(.*))?$/;
	var m = juniperRe.exec(details.url);
	if (!m) return false;
	
	var proxy = new Zotero.Proxy();
	proxy.multiHost = true;
	proxy.autoAssociate = false;
	proxy.scheme = m[1]+"/%d"+",DanaInfo=%h%a+%f";
	proxy.hosts = [m[3]];
	return proxy;
}


Zotero.Proxies.DNS = new function() {
	this.getHostnames = function() {
		var deferred = Zotero.Promise.defer();

		Zotero.Connector.callMethod('getClientHostnames', null, function(hostnames, status) {
			if (status !== 200) {
				deferred.reject(status);
			} else {
				Zotero.Proxies._clientHostnames = hostnames;
				deferred.resolve(hostnames);
			}
		});
		return deferred.promise;
	}
};

})();
