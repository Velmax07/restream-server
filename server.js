const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `https://restream-server-production.up.railway.app`;

const segmentCache = {};
const CACHE_TTL = 10000;
const playlistCache = {};
const PLAYLIST_TTL = 3000;

setInterval(() => {
    const now = Date.now();
    for (const key in segmentCache) {
        if (now - segmentCache[key].timestamp > CACHE_TTL) delete segmentCache[key];
    }
    for (const key in playlistCache) {
        if (now - playlistCache[key].timestamp > PLAYLIST_TTL) delete playlistCache[key];
    }
}, 30000);

function fetchUrl(targetUrl) {
    return new Promise((resolve, reject) => {
        const parsed = url.parse(targetUrl);
        const protocol = parsed.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.path,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
        };
        const req = protocol.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                data: Buffer.concat(chunks),
                contentType: res.headers['content-type'] || 'application/octet-stream',
                statusCode: res.statusCode
            }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

const pending = {};

async function getWithCache(targetUrl, cache, ttl) {
    const now = Date.now();
    if (cache[targetUrl] && now - cache[targetUrl].timestamp < ttl) return cache[targetUrl];
    if (pending[targetUrl]) return pending[targetUrl];
    pending[targetUrl] = fetchUrl(targetUrl).then(result => {
        cache[targetUrl] = { ...result, timestamp: Date.now() };
        delete pending[targetUrl];
        return cache[targetUrl];
    }).catch(err => { delete pending[targetUrl]; throw err; });
    return pending[targetUrl];
}

function rewriteM3u8(content, baseUrl) {
    return content.split('\n').map(line => {
        line = line.trim();
        if (line === '' || line.startsWith('#')) return line;
        let absoluteUrl = line.startsWith('http') ? line : baseUrl + line;
        return `${SERVER_URL}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
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
        res.end(JSON.stringify({ status: 'ok', message: 'Servidor de re-stream funcionando!', segments_cached: Object.keys(segmentCache).length }));
        return;
    }

    if (parsed.pathname === '/proxy') {
        const targetUrl = parsed.query.url;
        if (!targetUrl) { res.statusCode = 400; res.end('URL não informada'); return; }

        const decodedUrl = decodeURIComponent(targetUrl);
        const isM3u8 = decodedUrl.includes('.m3u8');
        const isTs = decodedUrl.includes('.ts');

        console.log(`[${isM3u8 ? 'M3U8' : isTs ? 'TS' : 'FILE'}] ${decodedUrl}`);

        try {
            if (isM3u8) {
                const result = await getWithCache(decodedUrl, playlistCache, PLAYLIST_TTL);
                const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);
                const rewritten = rewriteM3u8(result.data.toString(), baseUrl);
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.statusCode = result.statusCode;
                res.end(rewritten);
            } else if (isTs) {
                const result = await getWithCache(decodedUrl, segmentCache, CACHE_TTL);
                res.setHeader('Content-Type', 'video/mp2t');
                res.statusCode = result.statusCode;
                res.end(result.data);
            } else {
                const result = await fetchUrl(decodedUrl);
                res.setHeader('Content-Type', result.contentType);
                res.statusCode = result.statusCode;
                res.end(result.data);
            }
        } catch (err) {
            console.error(`Erro: ${err.message}`);
            if (!res.headersSent) { res.statusCode = 502; res.end('Erro: ' + err.message); }
        }
        return;
    }

    res.statusCode = 404; res.end('Não encontrado');
});

server.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
});
