// --- CONFIGURATION ---
const CLIENT_ID = 'b8dd7bad6b617b069d311f9efcd3b103';
const REDIRECT_URI = 'https://sempiternalsloth.github.io/MAL-MangaBaka-Sync/';

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

// --- Helper: Logging ---
function logger(msg, type = 'info') {
    logBox.style.display = 'block';
    const entry = document.createElement('div');
    entry.className = `log-${type}`;
    entry.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;
}

// --- Helper: PKCE ---
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
    // Buffer of 60 seconds
    localStorage.setItem('mal_token_expiry', Date.now() + ((expiresIn - 60) * 1000));
}

function clearToken() {
    localStorage.removeItem('mal_access_token');
    localStorage.removeItem('mal_token_expiry');
    localStorage.removeItem('mal_verifier');
}

// --- UI: Session Timer ---
function updateSessionUI() {
    const sessionDiv = document.getElementById('sessionInfo');
    const timerSpan = document.getElementById('expireTimer');
    const expiry = parseInt(localStorage.getItem('mal_token_expiry') || '0');

    if (expiry && Date.now() < expiry) {
        sessionDiv.style.display = 'flex';
        authBtn.style.background = "#1a4a1a";
        authBtn.innerText = "Logged In";
        
        const update = () => {
            const now = Date.now();
            const diff = expiry - now;
            if (diff <= 0) {
                sessionDiv.style.display = 'none';
                authBtn.innerText = "Authorize";
                authBtn.style.background = "#333";
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
        authBtn.innerText = "Authorize";
    }
}

// --- Analysis Logic ---
async function analyzeFiles() {
    const bakaFile = document.getElementById('bakaFile').files[0];
    const malFile = document.getElementById('malFile').files[0];
    if (!bakaFile || !malFile) return;

    logger("Analyzing files...", "info");
    try {
        const bakaText = await bakaFile.text();
        const bakaXml = new DOMParser().parseFromString(bakaText, "text/xml");
        const bakaEntries = Array.from(bakaXml.querySelectorAll('manga'));

        let malText;
        if (malFile.name.endsWith('.gz')) {
            const arrayBuffer = await malFile.arrayBuffer();
            const decompressed = fflate.decompressSync(new Uint8Array(arrayBuffer));
            malText = new TextDecoder().decode(decompressed);
        } else {
            malText = await malFile.text();
        }

        const malXml = new DOMParser().parseFromString(malText, "text/xml");
        const malEntriesList = Array.from(malXml.querySelectorAll('manga'));
        const malMap = new Map();
        malEntriesList.forEach(m => {
            const id = m.querySelector('manga_mangadb_id')?.textContent?.trim();
            if (id) malMap.set(id, m);
        });

        let changes = [];
        bakaEntries.forEach(b => {
            const id = b.querySelector('manga_mangadb_id')?.textContent?.trim();
            if (!id || id === "0") return;

            const title = b.querySelector('manga_title')?.textContent || `ID:${id}`;
            const mMatch = malMap.get(id);
            let diffDetails = [];
            let isNew = !mMatch;

            SYNC_FIELDS.forEach(f => {
                const bVal = b.querySelector(f)?.textContent?.trim() || "";
                const mVal = isNew ? "" : (mMatch.querySelector(f)?.textContent?.trim() || "");

                const isBakaEmpty = (bVal === "0" || bVal === "" || bVal === "0000-00-00" || bVal === "Plan to Read");
                const hasMalData = (mVal !== "0" && mVal !== "" && mVal !== "0000-00-00" && mVal !== "Plan to Read");

                if (bVal !== mVal) {
                    if (isBakaEmpty && hasMalData) return;
                    const label = `<span style="color:#88ccff;">${fieldLabels[f]}</span>`;
                    if (!hasMalData || isNew) {
                        if (!isBakaEmpty) diffDetails.push(`${label}: ${bVal}`);
                    } else {
                        diffDetails.push(`${label}: ${mVal} <span style="color:#ffcc00;">→</span> ${bVal}`);
                    }
                }
            });

            if (diffDetails.length > 0) changes.push({ id, title, diff: diffDetails.join(' | '), isNew });
        });

        document.getElementById('previewContainer').style.display = 'block';
        document.getElementById('changeCount').innerText = changes.length;
        document.getElementById('changeList').innerHTML = changes.map(c => {
            const tag = c.isNew ? `<span style="color:#00ff88; font-size:10px;">[ADDED]</span>` : `<span style="color:#ffcc00; font-size:10px;">[UPDATE]</span>`;
            return `<div class="change-item" style="margin-bottom:12px; border-bottom:1px solid #333; padding-bottom:8px;">
                ${tag} <span style="color:#ffffff; font-size:14px;">${c.title}</span><br>
                <div style="color:#ddd; font-size:12px; margin-left:15px; margin-top:4px;">${c.diff}</div>
            </div>`;
        }).join('') || "Lists are synced.";

        sessionStorage.setItem('baka_xml_data', bakaText);
        sessionStorage.setItem('baka_changes', JSON.stringify(changes.map(c => c.id)));
        logger("Analysis complete.", "success");
    } catch (e) { logger("Error: " + e.message, "error"); }
}

// --- Action Handlers ---
syncBtn.addEventListener('click', () => {
    const token = getStoredToken();
    if (!token) { alert("Please Authorize first."); return; }
    if (!sessionStorage.getItem('baka_xml_data')) { alert("Upload and Analyze files first."); return; }
    performSync(token);
});

authBtn.addEventListener('click', () => {
    const verifier = generateRandomString(128);
    localStorage.setItem('mal_verifier', verifier);
    const authUrl = new URL("https://myanimelist.net/v1/oauth2/authorize");
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('code_challenge', verifier);
    authUrl.searchParams.set('code_challenge_method', 'plain');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    window.location.href = authUrl.toString();
});

document.getElementById('resetBtn').addEventListener('click', (e) => {
    e.preventDefault();
    if(confirm("Log out and reset token?")) { clearToken(); location.reload(); }
});

window.onload = async () => {
    updateSessionUI();
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const verifier = localStorage.getItem('mal_verifier');

    if (code && verifier) {
        logger("Exchanging code for token...", "info");
        try {
            const proxyUrl = 'https://corsproxy.io/?';
            const response = await fetch(proxyUrl + encodeURIComponent('https://myanimelist.net/v1/oauth2/token'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID, grant_type: 'authorization_code',
                    code: code, code_verifier: verifier, redirect_uri: REDIRECT_URI
                })
            });
            const data = await response.json();
            if (data.access_token) {
                window.history.replaceState({}, document.title, REDIRECT_URI);
                storeToken(data.access_token, data.expires_in);
                updateSessionUI();
                logger(`Token acquired! Valid for ${(data.expires_in/86400).toFixed(1)} days.`, "success");
            }
        } catch (e) { logger("Auth failed: " + e.message, "error"); }
    }
};

async function performSync(token) {
    const bakaText = sessionStorage.getItem('baka_xml_data');
    const changedIds = JSON.parse(sessionStorage.getItem('baka_changes') || '[]');
    const bakaXml = new DOMParser().parseFromString(bakaText, "text/xml");
    const entries = Array.from(bakaXml.querySelectorAll('manga')).filter(b => 
        changedIds.includes(b.querySelector('manga_mangadb_id')?.textContent?.trim())
    );

    if (entries.length === 0) return;

    syncBtn.disabled = true;
    logger(`Starting sync for ${entries.length} items...`, "info");
    console.group(`=== MAL Sync Raw Output — ${entries.length} entries ===`);

    for (const b of entries) {
        const id = b.querySelector('manga_mangadb_id').textContent.trim();
        const title = b.querySelector('manga_title').textContent;
        
        let payload = {};
        SYNC_FIELDS.forEach(f => {
            let val = b.querySelector(f)?.textContent?.trim() || "";
            const key = fieldKeyMap[f];

            if (key === 'status') {
                val = val.toLowerCase().replace(/\s+/g, '_');
                if (val === 'planning') val = 'plan_to_read';
                if (val === 'on-hold') val = 'on_hold';
            }
            
            if (['score', 'num_volumes_read', 'num_chapters_read'].includes(key)) {
                val = parseInt(val, 10) || 0;
            }

            if (key.includes('date') && (val === "0000-00-00" || !val)) return;

            if (val !== undefined && val !== "") {
                payload[key] = val;
            }
        });

        // Logs
        console.log(`[${id}] ${title}`, payload);

        try {
            const proxyUrl = 'https://corsproxy.io/?';
            const targetUrl = `https://api.myanimelist.net/v2/manga/${id}/my_list_status`;
            
            const response = await fetch(proxyUrl + encodeURIComponent(targetUrl), {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(payload)
            });

            const resultData = await response.json();

            if (response.ok) {
                logger(`Synced: ${title}`, "success");
            } else {
                // If it fails, we log the deep error info to console only
                console.error(`FAILED [${response.status}] ${title}:`, resultData);
                logger(`Failed: ${title} (Status: ${response.status})`, "error");
            }
        } catch (e) {
            console.error(`System Error for ${title}:`, e);
            logger(`Error: ${e.message}`, "error");
        }

        // 250ms throttle to prevent MAL rate-limiting
        await new Promise(r => setTimeout(r, 250));
    }

    console.groupEnd();
    logger(`Sync process finished.`, "info");
    syncBtn.disabled = false;
}

document.getElementById('bakaFile').addEventListener('change', analyzeFiles);
document.getElementById('malFile').addEventListener('change', analyzeFiles);