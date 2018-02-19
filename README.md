## What
## Why

Anchora was designed to replace Apache and tools like XAMPP and become web dev's best friend. It is by default configured to be blazing fast thanks to HTTP2 push streams, caching on both ends, and also utilitarian with CORS and autogenerated and installed certificates for HTTPS development.

## How

Anchora uses all three node modules: `http` and either of `https` or `http2` in conjunction (since browsers only support HTTP2 secure connections, i.e. HTTP2 in HTTPS mode) atop which is compat layer for handling both 1.1 and 2.0 requests. ALPN negotiation allows supporting both HTTPS and HTTP2 over the same socket. Anchora then proceeds to open push streams with dependency files if and where available. 

See more [Node HTTP2 documentation](https://nodejs.org/dist/latest-v9.x/docs/api/http2.html#http2_compatibility_api) for more on compatibility and TODO

`http2` module is still in flux and 


## Features

Anchora is designed to support the hottest tech. Automatically and out of the box. With ease.

* HTTP2 push streams.
* Parsing HTML, JS and CSS files, extracting links, generating tree of dependencies. Through [`link-extract`](https://www.npmjs.com/package/link-extract) module. 
* Server-side in-memory caching of frequently used files.
* Client-side caching with etag.
* Automatically generated self-signed certificates for easy HTTPS localhost development.
* CORS headers.

## Supported headers

* 