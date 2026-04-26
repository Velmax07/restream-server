const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Cache de segmentos por stream
const streamCache = {};

function fetchStream(streamUrl, res) {
    const parsedUrl = url.parse(streamUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.path,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; IPTV/1.0)',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        }
    };

    const req = protocol.request(options, (upstream) => {
        // Adiciona headers CORS para permitir acesso de qualquer origem
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/vnd.apple.mpegurl');
        res.statusCode = upstream.statusCode;

        // Se for um .m3u8, reescreve as URLs dos segmentos para passar pelo proxy
        if (streamUrl.includes('.m3u8')) {
            let data = '';
            upstream.on('data', chunk => { data += chunk.toString(); });
            upstream.on('end', () => {
                // Reescreve URLs relativas para absolutas passando pelo servidor
                const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);
                const serverBase = process.env.SERVER_URL || `http://localhost:${PORT}`;

                const rewritten = data.split('\n').map(line => {
                    line = line.trim();
                    if (line.startsWith('#') || line === '') return line;
                    // URL absoluta
                    if (line.startsWith('http')) {
                        return `${serverBase}/proxy?url=${encodeURIComponent(line)}`;
                    }
                    // URL relativa
                    return `${serverBase}/proxy?url=${encodeURIComponent(baseUrl + line)}`;
                }).join('\n');

                res.end(rewritten);
            });
        } else {
            // Segmentos .ts — faz pipe direto
            upstream.pipe(res);
        }
    });

    req.on('error', (err) => {
        console.error('Erro ao buscar stream:', err.message);
        if (!res.headersSent) {
            res.statusCode = 502;
            res.end('Erro ao conectar ao servidor IPTV');
        }
    });

    req.setTimeout(15000, () => {
        req.destroy();
        if (!res.headersSent) {
            res.statusCode = 504;
            res.end('Timeout');
        }
    });

    req.end();
}

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.statusCode = 204;
        res.end();
        return;
    }

    // Rota de saúde
    if (parsedUrl.pathname === '/') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', message: 'Servidor de re-stream funcionando!' }));
        return;
    }

    // Rota do proxy
    if (parsedUrl.pathname === '/proxy') {
        const streamUrl = parsedUrl.query.url;
        if (!streamUrl) {
            res.statusCode = 400;
            res.end('URL não informada. Use /proxy?url=SUA_URL');
            return;
        }

        console.log(`[PROXY] ${new Date().toISOString()} → ${streamUrl}`);
        fetchStream(decodeURIComponent(streamUrl), res);
        return;
    }

    res.statusCode = 404;
    res.end('Rota não encontrada');
});

server.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
});
