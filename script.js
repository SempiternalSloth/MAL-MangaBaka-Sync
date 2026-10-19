// --- CONFIGURATION ---
const CLIENT_ID = 'b8dd7bad6b617b069d311f9efcd3b103';
const REDIRECT_URI = 'https://sempiternalsloth.github.io/MAL-MangaBaka-Sync/';
const PROXY = 'https://sscors.sempiternalsloth.workers.dev/?url=';
const AUTH_POPUP_NAME = 'mal_auth_popup';

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
function getStoredToken() {
    const token = localStorage.getItem('mal_access_token');
    const expiry = parseInt(localStorage.getItem('mal_token_expiry') || '0');
    if (token && Date.now() < expiry) return token;
    return null;
}

function storeToken(token, expiresIn) {
    localStorage.setItem('mal_access_token', token);
    localStorage.setItem('mal_token_expiry', Date.now() + ((expiresIn - 60) * 1000));
}

function clearToken() {
    localStorage.removeItem('mal_access_token');
    localStorage.removeItem('mal_token_expiry');
    localStorage.removeItem('mal_verifier');
}

// Checks the saved token with MAL. Clears it on a 401. Keeps it on other errors.
async function testToken() {
    const token = getStoredToken();
    if (!token) return;
    try {
        const res = await proxyFetch('https://api.myanimelist.net/v2/users/@me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401) {
            console.warn('[AUTH] Token rejected by MAL (401). Token cleared.');
            clearToken();
            updateSessionUI();
            logger('Saved token is not valid. Click Authorize to log in again.', 'error');
        } else if (res.ok) {
            console.log('[AUTH] Token test passed.');
        } else {
            console.warn(`[AUTH] Token test returned ${res.status}. Token kept.`);
        }
    } catch (e) {
        console.warn('[AUTH] Token test failed (network error). Token kept.', e);
    }
}

// --- UI ---
function setAuthButton(loggedIn) {
    if (loggedIn) {
        authBtn.style.background = '#1a4a1a';
        authBtn.style.color = '';
        authBtn.style.fontWeight = '';
        authBtn.innerText = 'Logged In';
    } else {
        authBtn.style.background = '#ffd800';
        authBtn.style.color = '#000';
        authBtn.style.fontWeight = 'bold';
        authBtn.innerText = 'Authorize';
    }
}

function updateSessionUI() {
    const sessionDiv = document.getElementById('sessionInfo');
    const timerSpan = document.getElementById('expireTimer');
    const expiry = parseInt(localStorage.getItem('mal_token_expiry') || '0');

    if (expiry && Date.now() < expiry) {
        sessionDiv.style.display = 'flex';
        setAuthButton(true);

        const update = () => {
            const diff = expiry - Date.now();
            if (diff <= 0) {
                sessionDiv.style.display = 'none';
                setAuthButton(false);
                return;
            }
            const days = Math.floor(diff / 86400000);
            const hours = Math.floor((diff % 86400000) / 3600000);
            const mins = Math.floor((diff % 3600000) / 60000);
            timerSpan.innerText = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
        };
        update();
    } else {
        sessionDiv.style.display = 'none';
        setAuthButton(false);
    }
}

// --- Analysis Logic ---
// Compares the two exports and shows the differences. Makes no network calls.
async function analyzeFiles() {
    const bakaFile = document.getElementById('bakaFile').files[0];
    const malFile = document.getElementById('malFile').files[0];
    if (!bakaFile || !malFile) return;

    logger('Analyzing files...', 'info');
    try {
        const bakaText = await bakaFile.text();
        const bakaXml = new DOMParser().parseFromString(bakaText, 'text/xml');
        const bakaEntries = Array.from(bakaXml.querySelectorAll('manga'));

        let malText;
        if (malFile.name.endsWith('.gz')) {
            const arrayBuffer = await malFile.arrayBuffer();
            const decompressed = fflate.decompressSync(new Uint8Array(arrayBuffer));
            malText = new TextDecoder().decode(decompressed);
        } else {
            malText = await malFile.text();
        }

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
                const mVal = isNew ? '' : (mMatch.querySelector(f)?.textContent?.trim() || '');

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
                    const fieldLabel = `<span style="color:#88ccff;">${fieldLabels[f]}</span>`;
                    if (!hasMalData || isNew) {
                        if (!isBakaEmpty) diffDetails.push(`${fieldLabel}: ${bVal}`);
                    } else {
                        diffDetails.push(`${fieldLabel}: ${mVal} <span style="color:#ffcc00;">→</span> ${bVal}`);
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
            const tag = c.isNew
                ? `<span style="color:#00ff88; font-size:10px;">[ADDED]</span>`
                : `<span style="color:#ffcc00; font-size:10px;">[UPDATE]</span>`;
            return `<div class="change-item" style="margin-bottom:12px; border-bottom:1px solid #333; padding-bottom:8px;">
                ${tag} <span style="color:#ffffff; font-size:14px;">${c.title}</span><br>
                <div style="color:#ddd; font-size:12px; margin-left:15px; margin-top:4px;">${c.diff}</div>
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

// Opens the MAL login in a popup, so the main page keeps the selected files.
authBtn.addEventListener('click', () => {
    const verifier = generateRandomString(128);
    localStorage.setItem('mal_verifier', verifier);
    const authUrl = new URL('https://myanimelist.net/v1/oauth2/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('code_challenge', verifier);
    authUrl.searchParams.set('code_challenge_method', 'plain');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);

    const popup = window.open(authUrl.toString(), AUTH_POPUP_NAME, 'width=520,height=720');
    if (!popup) {
        logger('Popup blocked. Redirecting. Select the files again after login.', 'error');
        window.location.href = authUrl.toString();
    }
});

// The popup saves the token. This event updates the main page.
window.addEventListener('storage', (e) => {
    if (e.key === 'mal_access_token' && e.newValue) {
        updateSessionUI();
        logger('Logged in.', 'success');
    }
});

document.getElementById('resetBtn').addEventListener('click', (e) => {
    e.preventDefault();
    if (confirm('Log out and reset token?')) {
        clearToken();
        updateSessionUI();
        logger('Token cleared.', 'info');
    }
});

// In the login popup, exchanges the code for a token. Otherwise tests the saved token.
window.onload = async () => {
    updateSessionUI();
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const verifier = localStorage.getItem('mal_verifier');
    const isPopup = window.name === AUTH_POPUP_NAME;

    if (code && verifier) {
        logger('Exchanging code for token...', 'info');
        try {
            const response = await proxyFetch('https://myanimelist.net/v1/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    grant_type: 'authorization_code',
                    code: code,
                    code_verifier: verifier,
                    redirect_uri: REDIRECT_URI
                })
            });

            const data = await response.json();
            if (data.access_token) {
                window.history.replaceState({}, document.title, REDIRECT_URI);
                storeToken(data.access_token, data.expires_in);
                localStorage.removeItem('mal_verifier');
                updateSessionUI();
                logger(`Token acquired! Valid for ${(data.expires_in / 86400).toFixed(1)} days.`, 'success');
                if (isPopup) setTimeout(() => window.close(), 500);
            } else {
                logger('Auth failed: ' + (data.message || data.error || 'Unknown error'), 'error');
            }
        } catch (e) {
            logger('Auth failed: ' + e.message, 'error');
        }
    } else if (getStoredToken()) {
        await testToken();
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

document.getElementById('bakaFile').addEventListener('change', analyzeFiles);
document.getElementById('malFile').addEventListener('change', analyzeFiles);
