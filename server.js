// ============================================================================
// NZBio Stremio Addon - Node.js Server for deploy.cx
// Stream movies and series from Usenet via NZB Hydra
// ============================================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  port: process.env.PORT || 3000,
  
  // NZB Hydra Settings
  hydraUrl: process.env.HYDRA_URL || 'http://147.219.59.219:5067',
  hydraApiKey: process.env.HYDRA_API_KEY || 'VFVDQBURIDPSP393CLG4CBNH8D',
  
  // TMDB API Key
  tmdbApiKey: process.env.TMDB_API_KEY || '96ca5e1179f107ab7af156b0a3ae9ca5',
  
  // Content Settings
  retentionDays: 365,
  searchTimeout: 15000,
  tmdbTimeout: 10000
};

// ============================================================================
// MANIFEST
// ============================================================================

const MANIFEST = {
  id: 'org.stremio.nzbio.deploycx',
  name: 'NZBio',
  version: '2.0.0',
  description: 'Stream movies and series directly from Usenet via NZB sources',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: 'https://i.imgur.com/GgJcJVw.png',
  background: 'https://i.imgur.com/yqlDCaC.jpg',
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Make HTTP(S) request
 */
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, options.timeout || 15000);
    
    const req = client.get(url, options, (res) => {
      clearTimeout(timeout);
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Convert IMDb ID to TMDB metadata
 */
async function getMetadata(imdbId) {
  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${CONFIG.tmdbApiKey}&external_source=imdb_id`;
    const response = await makeRequest(url, { timeout: CONFIG.tmdbTimeout });
    
    if (response.status !== 200) return null;
    
    const data = JSON.parse(response.data);
    
    // Check for movie
    if (data.movie_results?.length > 0) {
      const movie = data.movie_results[0];
      return {
        tmdbId: movie.id,
        title: movie.title,
        year: movie.release_date ? new Date(movie.release_date).getFullYear() : '',
        type: 'movie'
      };
    }
    
    // Check for TV series
    if (data.tv_results?.length > 0) {
      const show = data.tv_results[0];
      return {
        tmdbId: show.id,
        title: show.name,
        year: show.first_air_date ? new Date(show.first_air_date).getFullYear() : '',
        type: 'series'
      };
    }
    
    return null;
  } catch (error) {
    console.error('TMDB lookup failed:', error.message);
    return null;
  }
}

/**
 * Search NZB Hydra for content
 */
async function searchNZB(query) {
  try {
    const apiUrl = CONFIG.hydraUrl.endsWith('/api') 
      ? CONFIG.hydraUrl 
      : `${CONFIG.hydraUrl}/api`;
    
    const searchUrl = `${apiUrl}?apikey=${CONFIG.hydraApiKey}&t=search&q=${encodeURIComponent(query)}`;
    
    const response = await makeRequest(searchUrl, {
      timeout: CONFIG.searchTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/xml, application/rss+xml, text/xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    if (response.status !== 200) {
      console.error(`NZB search failed: ${response.status}`);
      return [];
    }
    
    const items = parseXML(response.data);
    
    // Filter by retention
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - CONFIG.retentionDays);
    
    return items.filter(item => {
      if (!item.pubDate) return true;
      const itemDate = new Date(item.pubDate);
      return !isNaN(itemDate.getTime()) && itemDate >= cutoffDate;
    });
    
  } catch (error) {
    console.error('NZB search error:', error.message);
    return [];
  }
}

/**
 * Parse XML response from NZB Hydra
 */
function parseXML(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const itemContent = match[1];
    
    const title = extractTag(itemContent, 'title');
    const link = extractTag(itemContent, 'link');
    const pubDate = extractTag(itemContent, 'pubDate');
    
    // Extract size
    let sizeInBytes = 0;
    const enclosureMatch = itemContent.match(/<enclosure[^>]*length="(\d+)"[^>]*>/i);
    if (enclosureMatch) {
      sizeInBytes = parseInt(enclosureMatch[1], 10);
    }
    
    // Format size
    let size = 'Unknown';
    if (sizeInBytes > 1024 * 1024 * 1024) {
      size = `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (sizeInBytes > 1024 * 1024) {
      size = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    
    // Extract quality markers
    const qualityRegex = /(4K|2160p|1080p|720p|480p|HDTV|WEB-DL|BluRay|HEVC|x265|H\.265|H264|x264)/gi;
    const qualityMatches = title.match(qualityRegex) || [];
    
    // Extract category
    const category = extractTag(itemContent, 'category') || 'Unknown';
    
    items.push({
      title,
      link,
      pubDate,
      sizeInBytes,
      size,
      quality: qualityMatches.join(' '),
      category
    });
  }
  
  return items;
}

/**
 * Extract XML tag value
 */
function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Create stream objects from NZB results
 */
function createStreams(nzbResults, metadata) {
  const streams = nzbResults.map(nzb => {
    // Determine quality tier
    const qualityMatch = nzb.quality.match(/(4K|2160p|1080p|720p|480p)/i);
    const quality = qualityMatch ? qualityMatch[1] : 'SD';
    
    // Build description
    const description = [
      `📁 ${metadata.title}`,
      `🎥 ${nzb.category}`,
      `📦 ${nzb.size}`,
      nzb.quality ? `🎬 ${nzb.quality}` : null
    ].filter(Boolean).join('\n');
    
    // Create binge group
    const bingeGroup = `org.stremio.nzbio|${quality.toLowerCase()}|${nzb.category.toLowerCase().replace(/\s+/g, '-')}`;
    
    return {
      name: `NZBio ${quality}`,
      description,
      url: nzb.link,  // Direct NZB URL
      behaviorHints: {
        notWebReady: true,
        filename: nzb.title,
        videoSize: nzb.sizeInBytes || undefined,
        bingeGroup
      }
    };
  });
  
  // Sort by quality preference
  const qualityOrder = { '2160p': 1, '4K': 2, '1080p': 3, '720p': 3, '480p': 4 };
  
  return streams.sort((a, b) => {
    const getQuality = (stream) => {
      for (const quality in qualityOrder) {
        if (stream.name.includes(quality)) return qualityOrder[quality];
      }
      return 999;
    };
    return getQuality(a) - getQuality(b);
  });
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Handle manifest request
 */
function handleManifest(req, res) {
  sendJSON(res, MANIFEST);
}

/**
 * Handle stream request
 */
async function handleStream(req, res, type, id) {
  try {
    // Decode URL-encoded ID
    const decodedId = decodeURIComponent(id);
    console.log(`Stream request: ${type}/${decodedId}`);
    
    // Parse request
    let imdbId = decodedId;
    let season, episode;
    
    if (type === 'series' && decodedId.includes(':')) {
      [imdbId, season, episode] = decodedId.split(':');
    }
    
    if (!imdbId.startsWith('tt')) {
      console.log('Invalid IMDb ID:', imdbId);
      return sendJSON(res, { streams: [] });
    }
    
    // Get metadata from TMDB
    const metadata = await getMetadata(imdbId);
    if (!metadata) {
      console.log('No TMDB metadata found for:', imdbId);
      return sendJSON(res, { streams: [] });
    }
    
    console.log('Found metadata:', metadata.title, metadata.year);
    
    // Build search query
    let searchQuery;
    if (type === 'movie') {
      searchQuery = `${metadata.title} ${metadata.year}`;
    } else {
      searchQuery = `${metadata.title} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
    }
    
    console.log('Searching NZB for:', searchQuery);
    
    // Search NZB Hydra
    const nzbResults = await searchNZB(searchQuery);
    
    if (!nzbResults || nzbResults.length === 0) {
      console.log('No NZB results found');
      return sendJSON(res, { streams: [] });
    }
    
    console.log(`Found ${nzbResults.length} NZB results`);
    
    // Create and return streams
    const streams = createStreams(nzbResults, metadata);
    console.log(`Returning ${streams.length} streams`);
    
    sendJSON(res, { streams });
    
  } catch (error) {
    console.error('Stream handler error:', error);
    sendJSON(res, { streams: [] });
  }
}

/**
 * Send JSON response
 */
function sendJSON(res, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(data));
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }
  
  // Route: /manifest.json or /
  if (path === '/manifest.json' || path === '/') {
    return handleManifest(req, res);
  }
  
  // Route: /stream/:type/:id.json
  const streamMatch = path.match(/^\/stream\/(movie|series)\/([^\/]+)\.json$/);
  if (streamMatch) {
    const [, type, id] = streamMatch;
    return handleStream(req, res, type, id);
  }
  
  // Default: return manifest
  handleManifest(req, res);
});

// Start server
server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`NZBio Stremio Addon running on port ${CONFIG.port}`);
  console.log(`Manifest: http://localhost:${CONFIG.port}/manifest.json`);
});
