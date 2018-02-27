import path from 'path'
import zlib from 'zlib'
import stream from 'stream'
import mimeLib from 'mime/lite'
import {fs, sanitizeUrl} from './util.mjs'
import {parse as extractLinks} from 'link-extract'


class FileDescriptor {

	constructor(server, url, readStatImmediately = true) {
		this.url = sanitizeUrl(url)
		this.fsPath = path.join(server.root, this.url)
		var parsed = path.parse(this.fsPath)
		this.name = parsed.base
		this.dir = parsed.dir
		this.ext = path.extname(this.name).slice(1)
		// NOTE: mime returns null for unknown types. We fall back to plain text in such case.
		this.mime = mimeLib.getType(this.ext) || server.unknownMime
		if (readStatImmediately)
			this.ready = this.readStat()
		// Passing refference to server instance and its options.
		this.server = server
		this.cache = server.cache
	}

	toJSON() {
		var    {name, mtimeMs, size, folder, file, url} = this
		return {name, mtimeMs, size, folder, file, url}
	}

	async readStat() {
		try {
			let stat = await fs.stat(this.fsPath)
			this.file = stat.isFile()
			this.folder = !this.file
			//this.folder = stat.isDirectory()
			this.size = stat.size
			this.mtime = stat.mtime
			this.mtimeMs = stat.mtimeMs
			this.ino = stat.ino
			if (this.file)
				this.etag = this.createEtag()
			this.exists = true
		} catch(err) {
			this.exists = false
		}
		return this
	}

	isCacheable() {
		if (this.size > this.cacheFileSize)
			return false
		var mimeList = this.server.cacheMimes
		return mimeList.includes(this.mime)
			|| mimeList.some(prefix => this.mime.startsWith(prefix))
	}

	// Only JS, HTML or CSS files under 1MB of size are parseable.
	isParseable() {
		if (this.size > 1024 * 1024)
			return false
		return this.mime === 'text/html'
			|| this.mime === 'text/javascript'
			|| this.mime === 'text/css'
	}

	// Only acceptable urls for caching are relative paths.
	isStreamable() {
		// Ignore css maps
		if (this.ext === 'map')
			return false
		if (this.server.pushStream === 'aggressive')
			return true
		var mimeList = this.server.pushStreamMimes
		return mimeList.includes(this.mime)
			|| mimeList.some(prefix => this.mime.startsWith(prefix))
	}

	createEtag() {
		var base = Buffer.from(`${this.size}-${this.mtimeMs}-${this.ino}`).toString('base64')
		return this.etag = `W/${base}`
	}

	// Gets cached buffer or opens Opens buffer, cache it, convert to stream and serve.
	async getReadStream(range) {
		// Try to get 
		if (range && range.end === undefined)
			range.end = this.size - 1
		if (this.isCacheable()) {
			var buffer = await this.getCachedBuffer()
			if (range)
				buffer = buffer.slice(range.start, range.end + 1)
			return createReadStreamFromBuffer(buffer)
		} else {
			// Open Stream.
			return fs.createReadStream(this.fsPath, range)
		}
	}

	async getCachedBuffer() {
		let cached = this.cache.get(this.url)
		if (cached && cached.buffer && cached.etag === this.etag)
			return cached.buffer
		else
			return this.getFreshBuffer()
	}

	async getFreshBuffer() {
		var buffer = await fs.readFile(this.fsPath)
		if (this.isCacheable())
			this.cache.setBuffer(this, buffer)
		return buffer
	}


	parseDependencies(buffer, desc) {
		var parsed = extractLinks(buffer.toString(), desc.ext)
		if (parsed) {
			// store and load peers
			// Transform sub urls relative to directory into absolute urls starting at root.
			var dirUrl = path.parse(desc.url).dir
			// NOTE: it is necessary for url to use forward slashes / hence the path.posix methods
			return parsed
				.filter(isUrlRelative)
				//.map(relUrl => this.openDescriptor(path.posix.join(dirUrl, relUrl), false))
				.map(relUrl => {
					var newUrl = path.posix.join(dirUrl, relUrl)
					var newDesc = new FileDescriptor(this.server, newUrl, false)
					return newDesc
				})
				.filter(desc => desc.isStreamable())
				.map(desc => desc.url)
			// TODO: some options.cacheFiles option to store or not store the stream (separate from desc and parsed deps)
		}
		return []
	}

	async getDependencies() {
		var cached = this.cache.get(this.url)
		if (cached && cached.deps && cached.etag === this.etag) {
			var directDeps = cached.deps
		} else {
			var buffer = cached && cached.buffer || await this.getFreshBuffer()
			// Parse for the first time.
			var directDeps = this.parseDependencies(buffer, this)
			this.cache.setDeps(this, directDeps)
		}
		// Return list of file's dependencies (fresh) and estimate of nested dependencies.
		// That is to prevent unnecessary slow disk reads of all files because window of opportunity
		// for pushing is short and checking freshness and possible reparsing of each file
		// would take a long time.
		// Best case scenario: Dependency files didn't change since we last parsed them.
		//                     Full and correct dependency tree is acquired.
		// Worst case scenario: Most dependency files either change or aren't parsed yet.
		//                      We're pushing incomplete list of files some of which might not be needed at all.
		//                      Client then re-requests missing files with another GETs. We cache and parse it then.
		return this.getNestedDependencies(directDeps)
	}

	getNestedDependencies(directDeps) {
		var allDeps = [...directDeps]
		for (var i = 0; i < allDeps.length; i++) {
			var cached = this.cache.get(allDeps[i])
			if (cached && cached.deps)
				mergeArrays(allDeps, cached.deps)
		}
		return allDeps
	}

}

function isUrlRelative(url) {
	return url.startsWith('./')
		|| url.startsWith('/')
		|| !url.includes('//')
}

function mergeArrays(arr1, arr2) {
	for (var i = 0; i < arr2.length; i++)
		if (!arr1.includes(arr2[i]))
			arr1.push(arr2[i])
}

export function openDescriptor(url, readStatImmediately = true) {
	var desc = new FileDescriptor(this, url, readStatImmediately)
	if (readStatImmediately)
		return desc.ready
	return desc
}




export function createReadStreamFromBuffer(buffer) {
	var readable = new stream.Readable
	readable._read = () => {}
	readable.push(buffer)
	readable.push(null)
	return readable
}

export function createCompressorStream(req, res) {
	var acceptEncoding = req.headers['accept-encoding']
	if (!acceptEncoding)
		return
	if (acceptEncoding.includes('gzip')) {
		// A compression format using the Lempel-Ziv coding (LZ77), with a 32-bit CRC.
		res.setHeader('content-encoding', 'gzip')
		return zlib.createGzip()
	}
	if (acceptEncoding.includes('deflate')) {
		// A compression format using the zlib structure, with the deflate compression algorithm.
		res.setHeader('content-encoding', 'deflate')
		return zlib.createDeflate()
	}
	/*
	if (acceptEncoding.includes('compress')) {
		// A compression format using the Lempel-Ziv-Welch (LZW) algorithm.
	}
	if (acceptEncoding.includes('br')) {
		// A compression format using the Brotli algorithm.
	}
	*/
}

export async function ensureDirectory(directory) {
	try {
		await fs.stat(directory)
	} catch(err) {
		await fs.mkdir(directory)
	}
}
