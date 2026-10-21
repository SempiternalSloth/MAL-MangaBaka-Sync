// --- CONFIGURATION ---
const CLIENT_ID = 'b8dd7bad6b617b069d311f9efcd3b103';
const REDIRECT_URI = 'https://sempiternalsloth.github.io/MAL-MangaBaka-Sync/';
const PROXY = 'https://mal-mb-cors.spinoyllau-cloudflare.workers.dev/?url=';
const AUTH_POPUP_NAME = 'mal_auth_popup';

// MangaBaka OAuth app. Set the client ID from your MangaBaka app. Use the same redirect URI as MAL.
const MB_CLIENT_ID = 'mTNqRFoUkjYpVuEwzMycZeiSGDOTQtUM';
const MB_DISCOVERY = 'https://mangabaka.org/.well-known/openid-configuration';
const MB_API = 'https://api.mangabaka.org';
const MB_SCOPE = 'openid library.read';

// Fields that are compared and sent to MAL.
const SYNC_FIELDS = [
    'my_read_chapters', 'my_read_volumes', 'my_status',
    'my_score', 'my_start_date', 'my_finish_date',
    'my_comments'
];

const fieldLabels = {
    'my_read_chapters': 'Chapters', 'my_read_volumes': 'Volumes',
    'my_status': 'Status', 'my_score': 'Score',
    'my_start_date': 'Start Date', 'my_finish_date': 'Finish Date',
    'my_comments': 'Comments'
};

// Export field names and the matching MAL API field names.
const fieldKeyMap = {
    'my_read_chapters': 'num_chapters_read',
    'my_read_volumes':  'num_volumes_read',
    'my_status':        'status',
    'my_score':         'score',
    'my_start_date':    'start_date',
    'my_finish_date':   'finish_date',
    'my_comments':      'comments'
};

const logBox = document.getElementById('logBox');
const syncBtn = document.getElementById('syncBtn');
const authBtn = document.getElementById('authBtn');
const mbAuthBtn = document.getElementById('mbAuthBtn');

// --- Helpers ---
function proxyFetch(url, options = {}) {
    return fetch(PROXY + encodeURIComponent(url), options);
}

function logger(msg, type = 'info') {
    logBox.style.display = 'block';
    const entry = document.createElement('div');
    entry.className = `log-${type}`;
    entry.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;
}

// Predicts the MAL clamp. MAL sets a Completed title to its total. A total of 0 means unknown.
function applyMalCaps(field, bVal, bStatus, caps, label = '') {
    if (!caps) return bVal;

    let total = 0;
    if (field === 'my_read_chapters') total = caps.chapters;
    if (field === 'my_read_volumes')  total = caps.volumes;
    if (!total) return bVal;

    const isCompleted = (bStatus || '').trim().toLowerCase() === 'completed';
    if (!isCompleted) return bVal;

    const n = parseInt(bVal, 10) || 0;
    let reason = null;
    if (n > total) reason = 'over MAL total';
    else if (n !== total) reason = 'completed -> set to MAL total';

    if (reason) {
        console.log(`[CAP] ${label} ${field}: ${bVal || '(empty)'} -> ${total} (${reason})`);
        return String(total);
    }
    return bVal;
}

// A totals lookup is only useful for Completed titles.
function shouldLookupTotals(entry) {
    const status = (entry.querySelector('my_status')?.textContent || '').trim().toLowerCase();
    return { needed: status === 'completed', status };
}

// Gets the totals of a title from the MAL API. Used for titles that are not in the MAL export.
async function fetchMalTotals(id, token) {
    try {
        const res = await proxyFetch(
            `https://api.myanimelist.net/v2/manga/${id}?fields=num_chapters,num_volumes`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (!res.ok) {
            console.warn(`[LOOKUP] ${id} failed with status ${res.status}`);
            return null;
        }
        const d = await res.json();
        return { chapters: d.num_chapters || 0, volumes: d.num_volumes || 0 };
    } catch (e) {
        console.warn(`[LOOKUP] ${id} error:`, e);
        return null;
    }
}

const generateRandomString = (length) => {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const randomValues = crypto.getRandomValues(new Uint8Array(length));
    for (let i = 0; i < length; i++) result += charset[randomValues[i] % charset.length];
    return result;
};

// --- Token Management ---
// prefix is 'mal' or 'mb'.
function getStoredToken(prefix = 'mal') {
    const token = localStorage.getItem(`${prefix}_access_token`);
    const expiry = parseInt(localStorage.getItem(`${prefix}_token_expiry`) || '0');
    if (token && Date.now() < expiry) return token;
    return null;
}

function storeToken(token, expiresIn, prefix = 'mal') {
    localStorage.setItem(`${prefix}_access_token`, token);
    localStorage.setItem(`${prefix}_token_expiry`, Date.now() + (((expiresIn || 3600) - 60) * 1000));
}

function clearToken(prefix = 'mal') {
    localStorage.removeItem(`${prefix}_access_token`);
    localStorage.removeItem(`${prefix}_token_expiry`);
    localStorage.removeItem(`${prefix}_verifier`);
}

// MangaBaka requests try a direct call first. They use the proxy only if the direct call fails.
// Do not use this for the code exchange, because a code works only once.
async function mbFetch(url, options = {}) {
    try {
        return await fetch(url, options);
    } catch (e) {
        console.warn('[MB] Direct request failed, using proxy.', e);
        return proxyFetch(url, options);
    }
}

// Builds an error with the message from the API response body, if there is one.
async function httpError(res) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch {}
    return new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
}

async function getMbEndpoints() {
    const res = await mbFetch(MB_DISCOVERY);
    const d = await res.json();
    if (!d.authorization_endpoint || !d.token_endpoint) throw new Error('Discovery document has no endpoints');
    return { auth: d.authorization_endpoint, token: d.token_endpoint };
}

async function pkceChallenge(verifier) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Checks a saved token with its API. Clears it on a 401. Keeps it on other errors.
async function testToken(prefix = 'mal') {
    const token = getStoredToken(prefix);
    if (!token) return;
    const name = prefix === 'mal' ? 'MAL' : 'MangaBaka';
    const url = prefix === 'mal' ? 'https://api.myanimelist.net/v2/users/@me' : `${MB_API}/v2/my/library?limit=1`;
    const doFetch = prefix === 'mal' ? proxyFetch : mbFetch;
    try {
        const res = await doFetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.status === 401) {
            const err = await httpError(res);
            console.warn(`[AUTH] ${name} token rejected. Token cleared.`, err.message);
            clearToken(prefix);
            updateSessionUI();
            logger(`Saved ${name} token was rejected (${err.message}). Click Authorize to log in again.`, 'error');
        } else if (res.ok) {
            console.log(`[AUTH] ${name} token test passed.`);
        } else {
            console.warn(`[AUTH] ${name} token test returned ${res.status}. Token kept.`);
        }
    } catch (e) {
        console.warn(`[AUTH] ${name} token test failed (network error). Token kept.`, e);
    }
}

// --- UI ---
// Logged out: the button starts the login. Logged in: the button loads the list from the API.
function renderSession(prefix, sessionId, timerId, btn, loadLabel) {
    const sessionDiv = document.getElementById(sessionId);
    const expiry = parseInt(localStorage.getItem(`${prefix}_token_expiry`) || '0');
    const loggedIn = expiry && Date.now() < expiry;

    sessionDiv.style.display = loggedIn ? 'flex' : 'none';
    btn.classList.toggle('needs-auth', !loggedIn);
    btn.innerText = loggedIn ? loadLabel : 'Authorize';
    if (!loggedIn) return;

    const diff = expiry - Date.now();
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    document.getElementById(timerId).innerText = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
}

function updateSessionUI() {
    renderSession('mal', 'sessionInfo', 'expireTimer', authBtn, 'Load MAL list');
    renderSession('mb', 'mbSessionInfo', 'mbExpireTimer', mbAuthBtn, 'Load Baka list');
}

// --- Analysis Logic ---
// Compares the two exports and shows the differences. Makes no network calls.
// The two lists, as XML text. They come from uploaded files or from the APIs.
const sources = { baka: null, mal: null };

const setSourceStatus = (key, text) => { document.getElementById(`${key}Status`).textContent = text; };
const countEntries = (xml) => (xml.match(/<manga>/g) || []).length;
const normalizeText = (v) => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

async function readFileText(file) {
    if (file.name.endsWith('.gz')) {
        const arrayBuffer = await file.arrayBuffer();
        return new TextDecoder().decode(fflate.decompressSync(new Uint8Array(arrayBuffer)));
    }
    return file.text();
}

async function analyzeFiles() {
    if (!sources.baka || !sources.mal) return;

    logger('Analyzing lists...', 'info');
    try {
        const bakaText = sources.baka;
        const bakaXml = new DOMParser().parseFromString(bakaText, 'text/xml');
        const bakaEntries = Array.from(bakaXml.querySelectorAll('manga'));
        const malText = sources.mal;

        // MAL entries by ID.
        const malXml = new DOMParser().parseFromString(malText, 'text/xml');
        const malMap = new Map();
        Array.from(malXml.querySelectorAll('manga')).forEach(m => {
            const id = m.querySelector('manga_mangadb_id')?.textContent?.trim();
            if (id) malMap.set(id, m);
        });

        const changes = [];
        const capsMap = {};

        console.group('=== MAL Cap Analysis ===');

        bakaEntries.forEach(b => {
            const id = b.querySelector('manga_mangadb_id')?.textContent?.trim();
            if (!id || id === '0') return;

            const title = b.querySelector('manga_title')?.textContent || `ID:${id}`;
            const mMatch = malMap.get(id);
            const isNew = !mMatch;
            const diffDetails = [];

            // MAL totals and read counts. New titles have none.
            let caps = null;
            if (mMatch) {
                caps = {
                    chapters: parseInt(mMatch.querySelector('manga_chapters')?.textContent, 10) || 0,
                    volumes:  parseInt(mMatch.querySelector('manga_volumes')?.textContent, 10) || 0,
                    readChapters: parseInt(mMatch.querySelector('my_read_chapters')?.textContent, 10) || 0,
                    readVolumes:  parseInt(mMatch.querySelector('my_read_volumes')?.textContent, 10) || 0
                };
                capsMap[id] = caps;
            }
            const bStatus = b.querySelector('my_status')?.textContent?.trim() || '';
            const label = `[${id}] ${title}`;

            SYNC_FIELDS.forEach(f => {
                let bVal = b.querySelector(f)?.textContent?.trim() || '';
                bVal = applyMalCaps(f, bVal, bStatus, caps, label);
                let mVal = isNew ? '' : (mMatch.querySelector(f)?.textContent?.trim() || '');

                // Ignore differences in spacing and line breaks in comments.
                if (f === 'my_comments') {
                    const nb = normalizeText(bVal);
                    const nm = normalizeText(mVal);
                    if (nb !== nm) console.log(`[COMMENT DIFF] ${label}: MAL=${JSON.stringify(mVal)} MangaBaka=${JSON.stringify(bVal)}`);
                    bVal = nb;
                    mVal = nm;
                }

                // A Completed title with a known total is not a change if MAL has the higher count.
                if (!isNew && caps && (f === 'my_read_chapters' || f === 'my_read_volumes')) {
                    const total = f === 'my_read_chapters' ? caps.chapters : caps.volumes;
                    const isCompleted = bStatus.toLowerCase() === 'completed';
                    if (isCompleted && total) {
                        const bNum = parseInt(bVal, 10) || 0;
                        const mNum = parseInt(mVal, 10) || 0;
                        if (mNum > bNum) {
                            console.log(`[MAL AHEAD] ${label} ${f}: MAL=${mNum}, MangaBaka=${bNum}, total=${total}. Ignored.`);
                            return;
                        }
                    }
                }

                const isBakaEmpty = (bVal === '0' || bVal === '' || bVal === '0000-00-00' || bVal === 'Plan to Read');
                const hasMalData = (mVal !== '0' && mVal !== '' && mVal !== '0000-00-00' && mVal !== 'Plan to Read');

                if (bVal !== mVal) {
                    if (isBakaEmpty && hasMalData) return;
                    const fieldLabel = fieldLabels[f];
                    if (!hasMalData || isNew) {
                        if (!isBakaEmpty) diffDetails.push(`${fieldLabel}: ${xmlEscape(bVal)}`);
                    } else {
                        diffDetails.push(`${fieldLabel}: ${xmlEscape(mVal)} <span class="arrow">→</span> ${xmlEscape(bVal)}`);
                    }
                }
            });

            if (diffDetails.length > 0) changes.push({ id, title, diff: diffDetails.join(' | '), isNew });
        });

        console.log(`Caps loaded from MAL export for ${Object.keys(capsMap).length} titles. ${changes.length} titles have changes.`);
        console.groupEnd();

        document.getElementById('previewContainer').style.display = 'block';
        document.getElementById('changeCount').innerText = changes.length;
        document.getElementById('changeList').innerHTML = changes.map(c => {
            const tag = c.isNew ? '[ADDED]' : '[UPDATE]';
            return `<div class="change-item">
                <div class="change-title">${tag} ${xmlEscape(c.title)}</div>
                <div class="change-diff">${c.diff}</div>
            </div>`;
        }).join('') || 'Lists are synced.';

        // Data for the sync step.
        sessionStorage.setItem('baka_xml_data', bakaText);
        sessionStorage.setItem('baka_changes', JSON.stringify(changes.map(c => c.id)));
        sessionStorage.setItem('baka_caps', JSON.stringify(capsMap));
        logger('Analysis complete.', 'success');
    } catch (e) {
        console.groupEnd();
        console.error('Analysis error:', e);
        logger('Error: ' + e.message, 'error');
    }
}

// --- Action Handlers ---
syncBtn.addEventListener('click', () => {
    const token = getStoredToken();
    if (!token) { alert('Please Authorize first.'); return; }
    if (!sessionStorage.getItem('baka_xml_data')) { alert('Upload and Analyze files first.'); return; }
    performSync(token);
});

// Opens a login popup, so the main page keeps the selected files.
async function startLogin(prefix, buildAuthUrl) {
    const popup = window.open('', AUTH_POPUP_NAME, 'width=520,height=720');
    try {
        const verifier = generateRandomString(128);
        localStorage.setItem(`${prefix}_verifier`, verifier);
        localStorage.setItem('auth_pending', prefix);
        const url = await buildAuthUrl(verifier);
        if (popup) {
            popup.location.href = url;
        } else {
            logger('Popup blocked. Redirecting. Select the files again after login.', 'error');
            window.location.href = url;
        }
    } catch (e) {
        if (popup) popup.close();
        console.error('Login error:', e);
        logger('Login failed: ' + e.message, 'error');
    }
}

authBtn.addEventListener('click', () => {
    if (getStoredToken('mal')) { loadMalFromApi(); return; }
    startLogin('mal', async (verifier) => {
        const u = new URL('https://myanimelist.net/v1/oauth2/authorize');
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', CLIENT_ID);
        u.searchParams.set('code_challenge', verifier);
        u.searchParams.set('code_challenge_method', 'plain');
        u.searchParams.set('redirect_uri', REDIRECT_URI);
        return u.toString();
    });
});

mbAuthBtn.addEventListener('click', () => {
    if (getStoredToken('mb')) { loadBakaFromApi(); return; }
    if (MB_CLIENT_ID.startsWith('YOUR_')) { logger('Set MB_CLIENT_ID in script.js first.', 'error'); return; }
    startLogin('mb', async (verifier) => {
        const { auth } = await getMbEndpoints();
        const u = new URL(auth);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', MB_CLIENT_ID);
        u.searchParams.set('redirect_uri', REDIRECT_URI);
        u.searchParams.set('scope', MB_SCOPE);
        u.searchParams.set('code_challenge', await pkceChallenge(verifier));
        u.searchParams.set('code_challenge_method', 'S256');
        return u.toString();
    });
});

// The popup saves the token. This event updates the main page.
window.addEventListener('storage', (e) => {
    if ((e.key === 'mal_access_token' || e.key === 'mb_access_token') && e.newValue) {
        updateSessionUI();
        logger('Logged in.', 'success');
        testToken(e.key === 'mb_access_token' ? 'mb' : 'mal');
    }
});

[['resetBtn', 'mal', 'MAL'], ['mbResetBtn', 'mb', 'MangaBaka']].forEach(([id, prefix, name]) => {
    document.getElementById(id).addEventListener('click', (e) => {
        e.preventDefault();
        if (confirm(`Log out of ${name} and reset token?`)) {
            clearToken(prefix);
            updateSessionUI();
            logger(`${name} token cleared.`, 'info');
        }
    });
});

// --- API lists ---
// Both APIs are converted to the same XML shape as the exports, so the analysis and sync stay the same.
const xmlEscape = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildXml(rows) {
    const tags = ['manga_mangadb_id', 'manga_title', 'manga_chapters', 'manga_volumes', ...SYNC_FIELDS];
    return '<myanimelist>' + rows.map(r =>
        '<manga>' + tags.map(t => `<${t}>${xmlEscape(r[t])}</${t}>`).join('') + '</manga>'
    ).join('') + '</myanimelist>';
}

const BAKA_STATUS = {
    reading: 'Reading', rereading: 'Reading', completed: 'Completed', paused: 'On-Hold',
    dropped: 'Dropped', plan_to_read: 'Plan to Read', considering: 'Plan to Read'
};
const MAL_STATUS = {
    reading: 'Reading', completed: 'Completed', on_hold: 'On-Hold',
    dropped: 'Dropped', plan_to_read: 'Plan to Read'
};
// Prefer the English title, then a romanized one, then the primary title.
function pickTitle(titles) {
    const byLang = (langs) => langs.map(l => titles.find(t => t.language === l)).find(Boolean);
    return (byLang(['en', 'ja-Latn', 'ko-Latn', 'zh-Latn', 'yue-Latn']) || titles.find(t => t.is_primary) || titles[0])?.title;
}
const dateOnly = (d) => d ? String(d).slice(0, 10) : '0000-00-00';

async function loadBakaFromApi() {
    const token = getStoredToken('mb');
    if (!token) return;
    logger('Loading MangaBaka library...', 'info');
    setSourceStatus('baka', 'Loading from API...');
    try {
        const items = [];
        for (let page = 1; ; page++) {
            const res = await mbFetch(`${MB_API}/v2/my/library?limit=100&page=${page}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw await httpError(res);
            const json = await res.json();
            items.push(...json.data);
            console.log(`[MB] page ${page}: ${json.data.length} entries`);
            if (!json.pagination?.next || json.data.length === 0) break;
        }

        let skipped = 0;
        const rows = [];
        items.forEach(({ entry, series }) => {
            const malId = series?.source?.my_anime_list?.id;
            if (!malId) { skipped++; console.log(`[MB] No MAL ID, skipped: series ${entry.series_id}`); return; }
            const titles = series.titles || [];
            rows.push({
                manga_mangadb_id: malId,
                manga_title: pickTitle(titles) || `ID:${malId}`,
                my_read_chapters: Math.floor(entry.progress_chapter || 0),
                my_read_volumes: Math.floor(entry.progress_volume || 0),
                my_status: BAKA_STATUS[entry.state] || 'Plan to Read',
                my_score: Math.round((entry.rating || 0) / 10),
                my_start_date: dateOnly(entry.start_date),
                my_finish_date: dateOnly(entry.finish_date),
                my_comments: new DOMParser().parseFromString(entry.note || '', 'text/html').body.textContent.replace(/<br\s*\/?>/gi, ' ').trim()
            });
        });

        sources.baka = buildXml(rows);
        setSourceStatus('baka', `API: ${rows.length} entries`);
        logger(`Loaded ${rows.length} MangaBaka entries (${skipped} without a MAL ID skipped).`, 'success');
        analyzeFiles();
    } catch (e) {
        console.error('MangaBaka load error:', e);
        logger('MangaBaka load failed: ' + e.message, 'error');
        setSourceStatus('baka', 'API load failed');
    }
}

async function loadMalFromApi() {
    const token = getStoredToken('mal');
    if (!token) return;
    logger('Loading MAL list...', 'info');
    setSourceStatus('mal', 'Loading from API...');
    try {
        const fields = 'num_chapters,num_volumes,list_status{start_date,finish_date,comments}';
        const rows = [];
        for (let offset = 0; ; offset += 1000) {
            const url = `https://api.myanimelist.net/v2/users/@me/mangalist?limit=1000&offset=${offset}&nsfw=1&fields=${encodeURIComponent(fields)}`;
            const res = await proxyFetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) throw await httpError(res);
            const json = await res.json();
            json.data.forEach(({ node, list_status: ls = {} }) => rows.push({
                manga_mangadb_id: node.id,
                manga_title: node.title,
                manga_chapters: node.num_chapters || 0,
                manga_volumes: node.num_volumes || 0,
                my_read_chapters: ls.num_chapters_read || 0,
                my_read_volumes: ls.num_volumes_read || 0,
                my_status: MAL_STATUS[ls.status] || 'Plan to Read',
                my_score: ls.score || 0,
                my_start_date: ls.start_date || '0000-00-00',
                my_finish_date: ls.finish_date || '0000-00-00',
                my_comments: ls.comments || ''
            }));
            console.log(`[MAL] offset ${offset}: ${json.data.length} entries`);
            if (json.data.length < 1000) break;
        }
        sources.mal = buildXml(rows);
        setSourceStatus('mal', `API: ${rows.length} entries`);
        logger(`Loaded ${rows.length} MAL entries.`, 'success');
        analyzeFiles();
    } catch (e) {
        console.error('MAL load error:', e);
        logger('MAL load failed: ' + e.message, 'error');
        setSourceStatus('mal', 'API load failed');
    }
}

// --- Login code exchange ---
const PROVIDERS = {
    mal: { name: 'MAL', clientId: CLIENT_ID, tokenUrl: async () => 'https://myanimelist.net/v1/oauth2/token' },
    mb:  { name: 'MangaBaka', clientId: MB_CLIENT_ID, tokenUrl: async () => (await getMbEndpoints()).token }
};

async function exchangeCode(prefix, code, isPopup) {
    const p = PROVIDERS[prefix];
    const verifier = localStorage.getItem(`${prefix}_verifier`);
    localStorage.removeItem('auth_pending');
    logger(`Exchanging ${p.name} code for token...`, 'info');
    let step = 'loading the endpoints';
    try {
        const tokenUrl = await p.tokenUrl();
        console.log(`[AUTH] ${p.name} token URL:`, tokenUrl);
        step = 'sending the token request';
        const response = await proxyFetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: p.clientId,
                grant_type: 'authorization_code',
                code: code,
                code_verifier: verifier,
                redirect_uri: REDIRECT_URI
            })
        });

        const data = await response.json();
        console.log(`[AUTH] ${p.name} token response:`, {
            token_type: data.token_type, scope: data.scope, expires_in: data.expires_in, refresh_token: !!data.refresh_token
        });
        if (data.access_token) {
            window.history.replaceState({}, document.title, REDIRECT_URI);
            storeToken(data.access_token, data.expires_in, prefix);
            localStorage.removeItem(`${prefix}_verifier`);
            updateSessionUI();
            logger(`${p.name} token acquired!`, 'success');
            if (isPopup) setTimeout(() => window.close(), 500);
        } else {
            console.error(`[AUTH] ${p.name} token response:`, data);
            logger(`${p.name} auth failed: ` + (data.message || data.error_description || data.error || 'Unknown error'), 'error');
        }
    } catch (e) {
        console.error(`[AUTH] ${p.name} exchange error:`, e);
        logger(`${p.name} auth failed while ${step}: ` + e.message, 'error');
    }
}

// In the login popup, exchanges the code for a token. Otherwise tests the saved tokens.
window.onload = async () => {
    updateSessionUI();
    const code = new URLSearchParams(window.location.search).get('code');
    const pending = localStorage.getItem('auth_pending');
    const isPopup = window.name === AUTH_POPUP_NAME || !!window.opener;

    if (code && PROVIDERS[pending]) {
        await exchangeCode(pending, code, isPopup);
    } else {
        await testToken('mal');
        await testToken('mb');
    }
};

// --- Sync Logic ---
// Sends each changed title to MAL, one at a time.
async function performSync(token) {
    const bakaText = sessionStorage.getItem('baka_xml_data');
    const changedIds = JSON.parse(sessionStorage.getItem('baka_changes') || '[]');
    const capsMap = JSON.parse(sessionStorage.getItem('baka_caps') || '{}');
    const bakaXml = new DOMParser().parseFromString(bakaText, 'text/xml');
    // Titles with comments are sent last.
    const hasComment = (b) => !!b.querySelector('my_comments')?.textContent?.trim();
    const entries = Array.from(bakaXml.querySelectorAll('manga'))
        .filter(b => changedIds.includes(b.querySelector('manga_mangadb_id')?.textContent?.trim()))
        .sort((a, b) => hasComment(a) - hasComment(b));

    if (entries.length === 0) return;

    syncBtn.disabled = true;
    logger(`Starting sync for ${entries.length} items...`, 'info');
    console.group(`=== MAL Sync Raw Output — ${entries.length} entries ===`);

    let lookupCount = 0;
    let skippedLookupCount = 0;

    for (const b of entries) {
        const id = b.querySelector('manga_mangadb_id').textContent.trim();
        const title = b.querySelector('manga_title').textContent;
        const bStatus = b.querySelector('my_status')?.textContent?.trim() || '';
        const label = `[${id}] ${title}`;

        // Totals come from the MAL export. New Completed titles use an API lookup.
        let caps = capsMap[id] || null;
        if (caps) {
            console.log(`[CAPS] ${label}: from export (chapters=${caps.chapters}, volumes=${caps.volumes})`);
        } else {
            const check = shouldLookupTotals(b);
            if (check.needed) {
                console.log(`[LOOKUP] ${label}: requesting totals (status="${check.status}")`);
                caps = await fetchMalTotals(id, token);
                lookupCount++;
                if (caps) {
                    console.log(`[LOOKUP] ${label}: got chapters=${caps.chapters}, volumes=${caps.volumes}`);
                } else {
                    console.warn(`[LOOKUP] ${label}: no totals returned, syncing uncapped`);
                }
                await new Promise(r => setTimeout(r, 250));
            } else {
                skippedLookupCount++;
                console.log(`[SKIP LOOKUP] ${label}: status="${check.status}" is not completed, no cap needed`);
            }
        }

        // Build the data for MAL.
        const payload = {};
        SYNC_FIELDS.forEach(f => {
            let val = b.querySelector(f)?.textContent?.trim() || '';
            val = applyMalCaps(f, val, bStatus, caps, label);
            const key = fieldKeyMap[f];

            if (key === 'status') {
                val = val.toLowerCase().replace(/\s+/g, '_');
                if (val === 'planning') val = 'plan_to_read';
                if (val === 'on-hold') val = 'on_hold';
            }

            if (['score', 'num_volumes_read', 'num_chapters_read'].includes(key)) {
                val = parseInt(val, 10) || 0;
            }

            // Do not lower a count that is higher on MAL (Completed titles with a known total).
            if (caps && (key === 'num_chapters_read' || key === 'num_volumes_read')) {
                const total = key === 'num_chapters_read' ? caps.chapters : caps.volumes;
                const malRead = key === 'num_chapters_read' ? caps.readChapters : caps.readVolumes;
                const isCompleted = bStatus.toLowerCase() === 'completed';
                if (isCompleted && total && typeof malRead === 'number' && malRead > val) {
                    console.log(`[MAL AHEAD] ${label} ${key}: MAL=${malRead}, MangaBaka=${val}, total=${total}. Not sent.`);
                    return;
                }
            }

            if (key.includes('date') && (val === '0000-00-00' || !val)) return;

            if (val !== undefined && val !== '') payload[key] = val;
        });

        console.log(`${label} payload:`, payload);

        try {
            const response = await proxyFetch(`https://api.myanimelist.net/v2/manga/${id}/my_list_status`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(payload)
            });

            const resultData = await response.json();
            if (response.ok) {
                logger(`Synced: ${title}`, 'success');
                console.log(`OK [${response.status}] ${title}:`, resultData);
            } else {
                console.error(`FAILED [${response.status}] ${title}:`, resultData);
                logger(`Failed: ${title} (${response.status}: ${resultData.message || resultData.error || 'Unknown'})`, 'error');
            }
        } catch (e) {
            console.error(`System Error for ${title}:`, e);
            logger(`Error: ${e.message}`, 'error');
        }

        await new Promise(r => setTimeout(r, 250));
    }

    console.log(`Lookup summary: ${lookupCount} API lookups made, ${skippedLookupCount} skipped.`);
    console.groupEnd();
    logger('Sync complete.', 'info');
    syncBtn.disabled = false;
}

[['bakaFile', 'baka'], ['malFile', 'mal']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setSourceStatus(key, 'Reading file...');
        sources[key] = await readFileText(file);
        setSourceStatus(key, `File: ${file.name} (${countEntries(sources[key])} entries)`);
        e.target.value = '';
        analyzeFiles();
    });
});
