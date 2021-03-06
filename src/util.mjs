import fsSync from 'fs'
import pathModule from 'path'
import util from 'util'
import nodeDebug from 'debug'


// Use 'debug' module by default but allow user to use custom logging function.
var originalDebug = nodeDebug('anchora')
export var debug = originalDebug
export function changeDebugger(customLog) {
	debug = customLog
}
export function resetDebugger() {
	debug = originalDebug
}

var {promisify} = util
export var fs = {
	readdir: promisify(fsSync.readdir),
	readFile: promisify(fsSync.readFile),
	writeFile: promisify(fsSync.writeFile),
	stat: promisify(fsSync.stat),
	createReadStream: fsSync.createReadStream,
	mkdir: promisify(fsSync.mkdir),
}

export const HTTPCODE = {
	200: 'OK',
	206: 'Partial Content',
	301: 'Moved Permanently',
	302: 'Moved Temporarily',
	304: 'Not Modified',
	400: 'Bad Request',
	403: 'Forbidden',
	404: 'Not Found',
	416: 'Requested Range Not Satisfiable',
	500: 'Internal Server Error',
}

// Unescapes special characters and removes query and hashes.
// Trims query strings (? and everything that follows in url).
export function sanitizeUrl(url) {
	url = decodeURI(url)
	var index = url.indexOf('?')
	if (index !== -1)
		return url.slice(0, index)
	return url
}
