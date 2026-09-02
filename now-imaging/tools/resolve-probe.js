// Usage: node tools/resolve-probe.js "Veil Nebula" — prints what the card would show.
'use strict';
const path = require('node:path');
const { createResolver } = require('../lib/resolve');
const r = createResolver({ overrides: require('../overrides.json'), cachePath: path.join(__dirname, '..', 'resolve-cache.json') });
r.resolve(process.argv[2] || 'Veil Nebula').then(x => console.log(JSON.stringify(x)));
