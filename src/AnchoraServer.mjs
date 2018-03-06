import events from 'events'
import http from 'http'
import https from 'https'
import http2 from 'http2'
import path from 'path'
import {defaultOptions} from './options.mjs'
import {createHttp1LikeReq, shimHttp1ToBeLikeHttp2, shimResMethods} from './shim.mjs'
import {AnchoraCache} from './cache.mjs'
import {debug} from './util.mjs'
import * as optionsProto from './options.mjs'
import * as serveProto from './serve.mjs'
import * as serveFileProto from './serve-file.mjs'
import * as serveDirectoryProto from './serve-directory.mjs'
import * as serveCgiProto from './serve-cgi.mjs'
import * as certProto from './cert.mjs'
import * as headersProto from './headers.mjs'
import * as filesProto from './files.mjs'
import pkg from '../package.json'


// TODO: test aggresive / optimized push stream settings
// TODO: non blocking parsing of subdependencies (dependecies in pushstream)
// TODO: consider implementing preload attribute and header
// TODO: enable CGI for HTTP2. because HTTP2 doesn't have 'req', it's just shimmed plain object
//       (var req = shimReqHttp1(headers)) but it needs to be stream to be piped from
//       req.pipe(cgi.stdin)

export class AnchoraServer {

	constructor(...args) {
		this.anchoraInfo = `Anchora-Static-Server/${pkg.version} Node/${process.version}`
		if (args.length) {
			this.applyArgs(args)
			this.normalizeOptions()
			this.ready = this.setup()
		} else {
			// NOTE: Class' derivatives using decorators are able to set instance values even
			//       before calling super() so this careful assignment (as to no overwrite anything)
			//       is necessary for some users.
			for (var [key, val] of Object.entries(defaultOptions)) {
				console.log(key, this[key] === undefined)
				if (this[key] === undefined)
					this[key] = defaultOptions[key]
			}
		}
	}

	async setup() {

		if (this.unsecurePort && typeof this.unsecurePort !== 'number') {
			this.unsecurePort = parseInt(this.unsecurePort)
			if (Number.isNan(this.unsecurePort))
				throw new Error(`Secure Port is incorrect. 'unsecurePort' has to be number`)
		}

		if (this.securePort && typeof this.securePort !== 'number') {
			this.securePort = parseInt(this.securePort)
			if (Number.isNan(this.securePort))
				throw new Error(`Secure Port is incorrect. 'securePort' has to be number`)
		}

		this.cache = new AnchoraCache(this)

		this.onRequest = this.onRequest.bind(this)
		this.onStream = this.onStream.bind(this)

		// Load or generate self-signed (for localhost and dev purposes only) certificates needed for HTTPS or HTTP2.
		if (this.secure)
			await this.loadOrGenerateCertificate()

		// HTTP1 can support both unsecure (HTTP) and secure (HTTPS) connections.
		if (this.http)
			this.serverUnsecure = http.createServer()
		if (this.https)
			this.serverSecure = https.createServer(this)

		// HTTP2 only supports secure connections.
		if (this.http2)
			this.serverSecure = http2.createSecureServer(this)

		// Enable Node's HTTP2 implementation to fall back to HTTP1 api and support HTTPS with HTTP2 server.
		if (this.http)
			this.allowHTTP1 = true

		// HTTP2 does not support unsecure connections. Only HTTP1 with its 'request' event does.
		if (this.unsecure)
			this.serverUnsecure.on('request', this.onRequest)

		// All secure connections (either over HTTP2 or HTTPS) are primarily handled with 'request' event.
		// HTTP2 falls back to 'request' unless this.allowHTTP1 is false or undefined.
		// In other words: hybrid mode (HTTP2 with support for HTTP1S) will primarily use the older v1 'request' API.
		if (this.secure) {
			if (this.http2 && !this.allowHTTP1)
				this.serverSecure.on('stream', this.onStream)
			else
				this.serverSecure.on('request', this.onRequest)
		}

		if (process.env.debug) {
			process.on('unhandledRejection', dump => {
				console.log('unhandledRejection', dump)
			})
			process.on('uncaughtException', dump => {
				console.log('uncaughtException', dump)
			})
		}

		if (await this.listen() && this.debug !== false)
			console.log(`server root: ${this.root}`)

		return this
	}

	// Alias for `options.http`
	get unsecure() {
		return this.http
	}

	// Alias for `options.https` or `options.http2`
	get secure() {
		return this.https || this.http2
	}

	// Handler for HTTP1 'request' event and shim differences between HTTP2 before it's passed to universal handler.
	onRequest(req, res) {
		debug('\n###', req.method, 'request', req.httpVersion, req.url)
		// Basic shims of http2 properties (http2 colon headers) on 'req' object.
		shimHttp1ToBeLikeHttp2(req)
		// Serve the request with unified handler.
		this.serve(req, res)
	}

	// Handler for HTTP2 'request' event and shim differences between HTTP1 before it's passed to universal handler.
	onStream(stream, headers) {
		debug('\n###', req.method, 'stream', req.url)
		// Shims http1 like 'req' object out of http2 headers.
		var req = createHttp1LikeReq(headers)
		// Adds shimmed http1 like 'res' methods onto 'stream' object.
		shimResMethods(stream)
		// Serve the request with unified handler.
		this.serve(req, stream)
	}

	setupBootListeners(server, port, name) {
		return new Promise((resolve, reject) => {
			var okMessage  = `${name} server listening on port ${port}`
			var errMessage = `EADDRINUSE: Port ${port} taken. ${name} server could not start`
			var onError = err => {
				if (err.code === 'EADDRINUSE') {
					server.removeListener('listening', onListen)
					if (process.env.debug)
						debug(errMessage)
					else if (this.debug !== false)
						console.error(errMessage)
					server.once('close', resolve)
					//server.once('close', () => reject(err))
					server.close()
				} else {
					if (process.env.debug)
						debug(err)
					else if (this.debug !== false)
						console.error(err)
				}
				server.removeListener('error', onError)
			}
			var onListen = () => {
				server.removeListener('error', onError)
				if (process.env.debug)
					debug(okMessage)
				else if (this.debug !== false)
					console.log(okMessage)
				resolve()
			}
			server.once('error', onError)
			server.once('listening', onListen)
		})
	}

	async listen() {
		if (this.serverUnsecure) {
			let promise = this.setupBootListeners(this.serverUnsecure, this.unsecurePort, `HTTP1 unsecure`)
			this.serverUnsecure.listen(this.unsecurePort)
			await promise
		}
		if (this.serverSecure) {
			let promise = this.setupBootListeners(this.serverSecure, this.securePort, `${this.http2 ? 'HTTP2' : 'HTTPS'} secure`)
			this.serverSecure.listen(this.securePort)
			await promise
		}
		// Return info if at least one server is running
		return this.listening
	}

	async close() {
		// TODO. promisify and handle 'close' event and errors.
		if (this.serverSecure && this.serverSecure.listening) {
			let promise = new Promise(resolve => this.serverSecure.once('close', resolve))
			this.serverSecure.close()
			await promise
		}
		if (this.serverUnsecure && this.serverUnsecure.listening) {
			let promise = new Promise(resolve => this.serverUnsecure.once('close', resolve))
			this.serverUnsecure.close()
			await promise
		}
	}

	get listening() {
		return this.serverSecure && this.serverSecure.listening
			|| this.unsecure && this.unsecure.listening
	}

	// Mimicking EventEmiter and routing event handlers to both servers

	on(...args) {
		if (this.serverSecure)   this.serverSecure.on(...args)
		if (this.serverUnsecure) this.serverUnsecure.on(...args)
	}
	once(...args) {
		if (this.serverSecure)   this.serverSecure.once(...args)
		if (this.serverUnsecure) this.serverUnsecure.once(...args)
	}
	removeListener(...args) {
		if (this.serverSecure)   this.serverSecure.removeListener(...args)
		if (this.serverUnsecure) this.serverUnsecure.removeListener(...args)
	}
	removeAllListeners(...args) {
		if (this.serverSecure)   this.serverSecure.removeAllListeners(...args)
		if (this.serverUnsecure) this.serverUnsecure.removeAllListeners(...args)
	}

}

var externalProto = [
	...Object.entries(optionsProto),
	...Object.entries(serveProto),
	...Object.entries(serveFileProto),
	...Object.entries(serveDirectoryProto),
	...Object.entries(serveCgiProto),
	...Object.entries(certProto),
	...Object.entries(headersProto),
	...Object.entries(filesProto),
]

for (var [name, method] of externalProto)
	AnchoraServer.prototype[name] = method

