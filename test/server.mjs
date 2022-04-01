import { createServer, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

ServerResponse.prototype.serveFile = function (file) { this.end(readFileSync(file)); }
ServerResponse.prototype.serveJS = function (file) { this.setHeader('content-type', 'text/javascript').end(readFileSync(file)); }

const port = 8001;

createServer((req, res) => {
	console.log(req.method, req.url);
	switch (req.url) {
		case '/': res.serveFile('./test.html'); break;
		case '/test.mjs': res.serveJS('./test.mjs'); break;
		case '/packbytes.mjs': res.serveJS('../packbytes.mjs'); break;
	}
}).listen(port, () => console.log(`listening on ${port}`));
