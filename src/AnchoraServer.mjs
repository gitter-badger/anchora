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


// TODO: non blocking parsing of subdependencies (dependecies in pushstream)
// TODO: consider implementing preload attribute and header
// TODO: enable CGI for HTTP2. because HTTP2 doesn't have 'req', it's just shimmed plain object
//       (var req = shimReqHttp1(headers)) but it needs to be stream to be piped from
//       req.pipe(cgi.stdin)

export class AnchoraServer {

	constructor(...args) {
		this.anchoraInfo = `Anchora-Static-Server/${pkg.version} Node/${process.version}`

		this.onRequest = this.onRequest.bind(this)
		this.onStream = this.onStream.bind(this)

		if (args.length) {
			this.applyArgs(args)
		} else {
			// NOTE: Class' derivatives using decorators are able to set instance values even
			//       before calling super() so this careful assignment (as to no overwrite anything)
			//       is necessary for some users.
			for (var [key, val] of Object.entries(defaultOptions)) {
				if (this[key] === undefined)
					this[key] = defaultOptions[key]
			}
			this.autoStart = false
		}
		this.normalizeOptions()

		// Enable 'debug' module and set DEBUG env variable if options.debug is set
		if (this.debug) {
			if (!process.env.DEBUG.includes('anchora'))
				process.env.DEBUG = 'anchora,' + process.env.DEBUG
		}

		if (process.env.DEBUG) {
			process.on('unhandledRejection', dump => {
				console.log('unhandledRejection', dump)
			})
			process.on('uncaughtException', dump => {
				console.log('uncaughtException', dump)
			})
		}

		this.cache = new AnchoraCache(this)

		if (this.autoStart !== false)
			this.ready = this.listen()
	}

	async listen(...ports) {
		this.normalizeOptions()

		// Close previous sessions, prepare reusal of the class
		await this.close()

		// Convert optional port arguments and apply the to the instance.
		if (ports.length === 1)
			this.applyPort(...ports)
		else if (ports.length > 1)
			this.applyPort(ports)

		if (this.portUnsecure && typeof this.portUnsecure !== 'number') {
			this.portUnsecure = parseInt(this.portUnsecure)
			if (Number.isNan(this.portUnsecure))
				throw new Error(`Secure Port is incorrect. 'portUnsecure' has to be number`)
		}

		if (this.portSecure && typeof this.portSecure !== 'number') {
			this.portSecure = parseInt(this.portSecure)
			if (Number.isNan(this.portSecure))
				throw new Error(`Secure Port is incorrect. 'portSecure' has to be number`)
		}

		// Load or generate self-signed (for localhost and dev purposes only) certificates needed for HTTPS or HTTP2.
		if (this.https || this.http2)
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
		if (this.http)
			this.serverUnsecure.on('request', this.onRequest)

		// All secure connections (either over HTTP2 or HTTPS) are primarily handled with 'request' event.
		// HTTP2 falls back to 'request' unless this.allowHTTP1 is false or undefined.
		// In other words: hybrid mode (HTTP2 with support for HTTP1S) will primarily use the older v1 'request' API.
		if (this.http2 && !this.allowHTTP1)
			this.serverSecure.on('stream', this.onStream)
		else if (this.http2 || this.https)
			this.serverSecure.on('request', this.onRequest)

		// Start listening.
		await this._listen()

		if (this.listening && this.debug !== false) {
			debug(`root: ${this.root}`)
			debug(`gzip: ${this.gzip}, cors: ${this.cors}, pushMode: ${this.pushMode}`)
		}
	}

	// Start listening on both unsecure and secure servers in parallel.
	_listen() {
		this.activeSockets = new Set
		return Promise.all([
			this.serverUnsecure && this.setupServer(this.serverUnsecure, this.portUnsecure, 'HTTP'),
			this.serverSecure && this.setupServer(this.serverSecure, this.portSecure, this.http2 ? 'HTTP2' : 'HTTPS'),
		])
	}
	// Forcefuly close both servers.
	async close() {
		// Destroy all keep-alive and otherwise open sockets because Node won't do it for us and we'd be stuck.
		if (this.activeSockets)
			this.activeSockets.forEach(socket => socket.destroy())
		// Actually close the servers now.
		await Promise.all([
			this.serverUnsecure && this.closeServer(this.serverUnsecure, this.portUnsecure, 'HTTP'),
			this.serverSecure && this.closeServer(this.serverSecure, this.portSecure, this.http2 ? 'HTTP2' : 'HTTPS'),
		])
		// Remove refferences to the servers.
		this.serverSecure = undefined
		this.serverUnsecure = undefined
	}

	setupServer(server, port, name) {
		// Keep track of active sockets so the keep-alive ones can be manualy destroyed when calling .close()
		// because Node doesn't do it for and and leave's us hanging.
		server.on('connection', socket => {
			this.activeSockets.add(socket)
			socket.on('close', () => this.activeSockets.delete(socket))
		})
		// Start listening and print appropriate info.
		return this._listenAsync(server, port)
			.then(listening => {
				if (listening) this.logInfo(`${name} server listening on port ${port}`)
				else this.logError(`EADDRINUSE: Port ${port} taken. ${name} server could not start`)
			})
			.catch(err => this.logError(err))
	}
	async closeServer(server, port, name) {
		if (server && server.listening) {
			server.removeAllListeners()
			await new Promise(resolve => server.close(resolve))
			this.logInfo(`${name} server stopped listening on port ${port}`)
		}
	}

	_listenAsync(server, port) {
		return new Promise((resolve, reject) => {
			function onError(err) {
				if (err.code === 'EADDRINUSE') {
					server.removeListener('listening', onListen)
					server.close(() => resolve(false))
				} else {
					reject(err)
				}
				server.removeListener('error', onError)
			}
			function onListen() {
				server.removeListener('error', onError)
				resolve(true)
			}
			server.once('error', onError)
			server.once('listening', onListen)
			server.listen(port)
		})
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

	get listening() {
		var value = this.serverSecure && this.serverSecure.listening
				 || this.serverUnsecure && this.serverUnsecure.listening
		return !!value
	}

	// TODO: replace console.log/error with different verbosity level of debug()
	logInfo(...args) {
		if (process.env.debug)
			debug(...args)
		else if (this.debug !== false)
			console.log(...args)
	}
	logError(...args) {
		if (process.env.debug)
			debug(...args)
		else if (this.debug !== false)
			console.error(...args)
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

