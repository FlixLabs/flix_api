import { createStorageServer } from './server.js';

const locations = [
  { id: 'movies', path: '/storage/movies' },
  { id: 'series', path: '/storage/series' },
  { id: 'downloads', path: '/storage/downloads' },
];

createStorageServer({ token: process.env.STORAGE_AGENT_TOKEN, locations }).listen(9010, '0.0.0.0');
