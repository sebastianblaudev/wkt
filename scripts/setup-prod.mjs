"use strict";

const fs = require('fs');
const path = require('path');

// Make landing page accessible via / (and removed old landing page)
const copyFile = (source, dest) => {
    try {
        if (fs.existsSync(source)) {
            fs.copyFileSync(source, dest);
            console.log(`✅ Copied ${source} → ${dest}`);
        } else {
            console.warn(`⚠️ Source not found: ${source}`);
        }
    } catch (err) {
        console.error(`❌ Copy failed: ${source} → ${dest}`, err.message);
    }
};

// In production on InstaPods: / serves landing.html (old) 
// After setup: / serves index.html (new landing.html) 
// We copy index.html (new landing) to index-dist.html for /index 
// Then modify server.cjs to serve landing.html at /

const rootDir = path.join(__dirname, '..');
const landingSource = path.join(rootDir, 'landing.html');
const landingDest = path.join(rootDir, 'index-dist.html');

const indexSource = path.join(rootDir, 'index.html');
const indexDest = path.join(rootDir, 'index-dist.html');

const adminHtml = path.join(rootDir, 'admin.html');
const adminJs = path.join(rootDir, 'admin.js');
const adminCss = path.join(rootDir, 'style.css');
const superadminHtml = path.join(rootDir, 'superadmin.html');
const superadminJs = path.join(rootDir, 'superadmin.js');
const adminPhoto = path.join(rootDir, 'admin-photo.jpg');

console.log('🚀 Starting production setup...');

// Copy new landing (index.html) to index-dist.html 
copyFile(indexSource, indexDest);

// Copy landing page to index.html for / (instapods default)
copyFile(landingSource, path.join(rootDir, 'index.html'));

// Copy admin files to root (for direct serve) if they exist
copyFile(adminHtml, path.join(rootDir, 'admin-dist.html'));
copyFile(adminJs, path.join(rootDir, 'admin-dist.js'));
copyFile(adminCss, path.join(rootDir, 'admin-dist.css'));
copyFile(superadminHtml, path.join(rootDir, 'superadmin-dist.html'));
copyFile(superadminJs, path.join(rootDir, 'superadmin-dist.js'));
copyFile(adminPhoto, path.join(rootDir, 'admin-photo.jpg'));

console.log('\n' + '='.repeat(50));
console.log('✅ Production setup complete.');
console.log('='.repeat(50));
console.log('\nNow you need to update server.cjs to serve:');
console.log('   app.get(\'/\', (req, res) => res.sendFile(path.join(__dirname, \'index-dist.html\'))); // <-- Changed!');
console.log('\nAlso test in your browser:');
console.log('   https://wkt.ash-2.instapods.app/ (landing)');
console.log('   https://wkt.ash-2.instapods.app/index (index-dist)');
console.log('   https://wkt.ash-2.instapods.app/admin (admin-dist)');
console.log('   https://wkt.ash-2.instapods.app/superadmin (superadmin-dist)');
