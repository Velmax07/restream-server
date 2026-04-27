const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || 'https://restream-server-production.up.railway.app';

// Cache de segmentos — evita buscar o mesmo segmento 2x ao mesmo tempo
const cache = {};
const CACHE_TTL = 8000; // 8 segundos

setInterval(() => {
    const now = Date.now();
    for (const key in cache) {
        if (now - cache[key].ts > CACHE_TTL) delete cache[key];
    }
}, 15000);

function fetchUrl(targetUrl) {
    return new Promise((resolve, reject) => {
        const parsed = url.parse(targetUrl);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.path,
            method: 'GET',
            headers: {
                'User-Agent': 'MegaPlay/0.4.4 (Media3 ExoPlayer)',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip',
                'Connection': 'Keep-Alive'
            }
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                data: Buffer.concat(chunks),
                type: res.headers['content-type'] || 'application/octet-stream',
                status: res.statusCode
            }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

// Pendentes — evita buscar a mesma URL 2x simultaneamente
const pending = {};

async function getWithCache(targetUrl) {
    const now = Date.now();
    if (cache[targetUrl] && now - cache[targetUrl].ts < CACHE_TTL) {
        return cache[targetUrl];
    }
    if (pending[targetUrl]) return pending[targetUrl];

    pending[targetUrl] = fetchUrl(targetUrl).then(r => {
        cache[targetUrl] = { ...r, ts: Date.now() };
        delete pending[targetUrl];
        return cache[targetUrl];
    }).catch(e => {
        delete pending[targetUrl];
        throw e;
    });

    return pending[targetUrl];
}

function rewriteM3u8(content, baseUrl) {
    return content.split('\n').map(line => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return l;
        const abs = l.startsWith('http') ? l : baseUrl + l;
        return `${SERVER_URL}/proxy?url=${encodeURIComponent(abs)}`;
    }).join('\n');
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    if (parsed.pathname === '/') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', cached: Object.keys(cache).length }));
        return;
    }

    if (parsed.pathname === '/proxy') {
        const rawUrl = parsed.query.url;
        if (!rawUrl) { res.statusCode = 400; res.end('URL missing'); return; }

        const targetUrl = decodeURIComponent(rawUrl);
        const isM3u8 = targetUrl.includes('.m3u8');
        const isTs = targetUrl.includes('.ts');

        console.log(`[${isM3u8 ? 'M3U8' : isTs ? 'TS' : 'FILE'}] ${targetUrl.substring(0, 80)}`);

        try {
            if (isTs) {
                // Segmentos de vídeo — cache compartilhado entre dispositivos
                const result = await getWithCache(targetUrl);
                res.setHeader('Content-Type', 'video/mp2t');
                res.statusCode = result.status;
                res.end(result.data);
            } else if (isM3u8) {
                // Playlist — reescreve URLs para passar pelo proxy
                const result = await getWithCache(targetUrl);
                const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                const rewritten = rewriteM3u8(result.data.toString(), base);
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.statusCode = result.status;
                res.end(rewritten);
            } else {
                const result = await fetchUrl(targetUrl);
                res.setHeader('Content-Type', result.type);
                res.statusCode = result.status;
                res.end(result.data);
            }
        } catch (e) {
            console.error('Erro:', e.message);
            if (!res.headersSent) { res.statusCode = 502; res.end('Erro: ' + e.message); }
        }
        return;
    }

    res.statusCode = 404; res.end('Not found');
});

server.listen(PORT, () => console.log(`✅ Servidor na porta ${PORT}`));
