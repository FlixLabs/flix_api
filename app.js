import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import { createClient } from 'redis';

const app = express();
const port = 3000;

app.use(express.json());

app.use(cors({
  origin: process.env.FLIX_APP_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const redisClient = createClient({
  url: `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
});

redisClient.on('connect', () => {
  console.log('Connected to Redis');
});

redisClient.on('error', (err) => {
  console.error('Redis error:', err);
});

app.get('/auth', (req, res) => {
  (async () => {
    let data = {};
    const instanceData = await redisClient.json.get('auth');

    if (instanceData) {
      data = instanceData;
    }

    res.send(data);
  })();
})

app.post('/auth', (req, res) => {
  (async () => {
    const data = req.body
    if (data.username && data.password) {
      await redisClient.json.set('auth', '$', data);
    }

    res.sendStatus(200);
  })();
})

app.delete('/auth', (req, res) => {
  (async () => {
    await redisClient.json.del('auth');

    res.sendStatus(200);
  })();
})

app.get('/instances', (req, res) => {
  (async () => {
    const instanceData = await redisClient.json.get(process.env.INSTANCE_FILE);

    res.send(instanceData);
  })();
})

app.listen(port, () => {
  (async () => {
    await redisClient.connect();

    const data = fs.readFileSync('./' + process.env.INSTANCE_FILE, 'utf8');
    await redisClient.json.set(process.env.INSTANCE_FILE, '$', JSON.parse(data));

    console.log('RedisService initialized');
    console.log(`App listening on port ${port}`);
  })();
})
