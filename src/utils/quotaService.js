const fs = require('fs');
const path = require('path');
const https = require('https');

const GEMINI_DIR = path.join(process.env.HOME || '/home/dev', '.gemini');
const GEMINI_OAUTH_FILE = path.join(GEMINI_DIR, 'oauth_creds.json');
const PROJECTS_FILE = path.join(GEMINI_DIR, 'projects.json');

const AGY_DIR = path.join(GEMINI_DIR, 'antigravity-cli');
const AGY_OAUTH_FILE = path.join(AGY_DIR, 'antigravity-oauth-token');

// Load client credentials dynamically from the globally installed bundle to avoid pushing secrets to git
function loadClientCredentials() {
  let clientId = null;
  let clientSecret = null;

  const bundleDir = '/usr/lib/node_modules/@google/gemini-cli/bundle';
  if (fs.existsSync(bundleDir)) {
    try {
      const files = fs.readdirSync(bundleDir);
      for (const file of files) {
        if (file.endsWith('.js')) {
          const filePath = path.join(bundleDir, file);
          const stat = fs.statSync(filePath);
          if (stat.size < 25000000) {
            const content = fs.readFileSync(filePath, 'utf8');
            const idMatch = content.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/);
            const secretMatch = content.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/);
            if (idMatch) clientId = idMatch[1];
            if (secretMatch) clientSecret = secretMatch[1];
            if (clientId && clientSecret) break;
          }
        }
      }
    } catch (e) {}
  }
  return {
    clientId: clientId || process.env.OAUTH_CLIENT_ID,
    clientSecret: clientSecret || process.env.OAUTH_CLIENT_SECRET
  };
}

const credentials = loadClientCredentials();
const OAUTH_CLIENT_ID = credentials.clientId;
const OAUTH_CLIENT_SECRET = credentials.clientSecret;

// Helper to make HTTPS requests
function request(url, options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Refresh OAuth access token
async function refreshAccessToken(refreshToken) {
  const url = 'https://oauth2.googleapis.com/token';
  const body = JSON.stringify({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const res = await request(url, options, body);
  if (res.status !== 200) {
    throw new Error(`Token refresh failed with status ${res.status}: ${JSON.stringify(res.data || res.raw)}`);
  }
  return res.data;
}

// Load and refresh Gemini credentials
async function getGeminiToken() {
  if (!fs.existsSync(GEMINI_OAUTH_FILE)) return null;
  let creds = JSON.parse(fs.readFileSync(GEMINI_OAUTH_FILE, 'utf8'));
  const now = Date.now();

  if (!creds.access_token || !creds.expiry_date || creds.expiry_date - now < 60000) {
    if (!creds.refresh_token) return null;
    try {
      const refreshed = await refreshAccessToken(creds.refresh_token);
      creds.access_token = refreshed.access_token;
      if (refreshed.expires_in) {
        creds.expiry_date = Date.now() + (refreshed.expires_in * 1000);
      }
      fs.writeFileSync(GEMINI_OAUTH_FILE, JSON.stringify(creds, null, 2), 'utf8');
    } catch (err) {
      console.error("Warning: Gemini token refresh failed:", err.message);
      return null;
    }
  }
  return creds.access_token;
}

// Load and refresh Antigravity credentials
async function getAntigravityToken() {
  if (!fs.existsSync(AGY_OAUTH_FILE)) return null;
  let authData = JSON.parse(fs.readFileSync(AGY_OAUTH_FILE, 'utf8'));
  if (!authData.token) return null;
  
  const tokenData = authData.token;
  const now = Date.now();
  const expiryMs = tokenData.expiry ? Date.parse(tokenData.expiry) : 0;

  if (!tokenData.access_token || !expiryMs || expiryMs - now < 60000) {
    if (!tokenData.refresh_token) return null;
    try {
      const refreshed = await refreshAccessToken(tokenData.refresh_token);
      tokenData.access_token = refreshed.access_token;
      if (refreshed.expires_in) {
        tokenData.expiry = new Date(Date.now() + (refreshed.expires_in * 1000)).toISOString();
      }
      fs.writeFileSync(AGY_OAUTH_FILE, JSON.stringify(authData, null, 2), 'utf8');
    } catch (err) {
      console.error("Warning: Antigravity token refresh failed:", err.message);
      return null;
    }
  }
  return tokenData.access_token;
}

// Get Gemini project ID
function getGeminiProjectId() {
  let projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!projectId && fs.existsSync(PROJECTS_FILE)) {
    try {
      const projData = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      if (projData.projects) {
        projectId = Object.values(projData.projects)[0];
      }
    } catch (e) {}
  }
  return projectId || 'dev';
}

async function getQuotaDetails(token, projectId) {
  if (!token) return null;

  const quotaUrl = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
  const body = JSON.stringify({ project: projectId });
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };

  try {
    const res = await request(quotaUrl, options, body);
    if (res.status !== 200) return null;
    return res.data;
  } catch (err) {
    console.error("Failed to query quota API:", err.message);
    return null;
  }
}

function formatQuotaMarkdown(quotaData, label, projectId) {
  if (!quotaData || !quotaData.buckets || quotaData.buckets.length === 0) {
    return `*No active quota limits or quota is unrestricted.*`;
  }

  let text = '';
  for (const bucket of quotaData.buckets) {
    const modelId = bucket.modelId || 'Unknown Model';
    const remainingFraction = bucket.remainingFraction !== undefined ? bucket.remainingFraction : 1.0;
    const remainingPercentage = Math.round(remainingFraction * 100);
    const usedPercentage = 100 - remainingPercentage;
    
    let amountDetail = '';
    if (bucket.remainingAmount) {
      const remaining = parseInt(bucket.remainingAmount, 10);
      const limit = remainingFraction > 0 ? Math.round(remaining / remainingFraction) : 'unknown';
      amountDetail = ` (${remaining.toLocaleString()} / ${limit.toLocaleString()} tokens remaining)`;
    }

    let resetDetail = '';
    if (bucket.resetTime) {
      const resetDate = new Date(bucket.resetTime);
      const diffMs = resetDate - Date.now();
      if (diffMs > 0) {
        const diffHours = Math.floor(diffMs / 3600000);
        const diffMins = Math.floor((diffMs % 3600000) / 60000);
        resetDetail = ` [Resets in ${diffHours}h ${diffMins}m]`;
      } else {
        resetDetail = ` [Reset pending]`;
      }
    }

    const barLength = 15;
    const filledLength = Math.round((remainingPercentage / 100) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

    text += `• **${modelId}**\n`;
    text += `  \`[${bar}] ${remainingPercentage}% remaining (${usedPercentage}% used)\`\n`;
    if (amountDetail || resetDetail) {
      text += `  *Info:${amountDetail}${resetDetail}*\n`;
    }
  }
  return text;
}

async function getLiveQuotaReport() {
  let report = `### 📊 Live Google Gemini API Quotas\n`;

  // Gemini Project-based
  try {
    const geminiToken = await getGeminiToken();
    const geminiProj = getGeminiProjectId();
    const geminiData = await getQuotaDetails(geminiToken, geminiProj);
    
    report += `**♊ Gemini CLI (Project-based: \`${geminiProj}\`)**\n`;
    if (geminiToken && geminiData) {
      report += formatQuotaMarkdown(geminiData, "Gemini", geminiProj);
    } else {
      report += `*Credentials unavailable or failed to connect to Google API.*\n`;
    }
  } catch (err) {
    report += `*Error retrieving Gemini quota: ${err.message}*\n`;
  }

  report += `\n`;

  // Antigravity Consumer-based
  try {
    const agyToken = await getAntigravityToken();
    const agyData = await getQuotaDetails(agyToken, "");
    
    report += `**🪐 Antigravity CLI (Consumer-based)**\n`;
    if (agyToken && agyData) {
      report += formatQuotaMarkdown(agyData, "Antigravity", "");
    } else {
      report += `*Credentials unavailable or failed to connect to Google API.*\n`;
    }
  } catch (err) {
    report += `*Error retrieving Antigravity quota: ${err.message}*\n`;
  }

  return report;
}

module.exports = {
  getGeminiToken,
  getAntigravityToken,
  getGeminiProjectId,
  getQuotaDetails,
  formatQuotaMarkdown,
  getLiveQuotaReport
};
