require('dotenv').config();
const express = require('express');
const path = require('path');
const indexRouter = require('./routes/index');

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/', indexRouter);

  return app;
}

function startServer(customPort) {
  const app = createApp();
  let port = Number(customPort || process.env.PORT) || 3000;
  let server = null;

  function tryListen(p, attemptsLeft = 10) {
    return new Promise((resolve, reject) => {
      server = app.listen(p)
        .once('listening', () => {
          console.log(`Panel çalışıyor: http://localhost:${p}`);
          resolve({ app, server, port: p });
        })
        .once('error', (err) => {
          if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            console.warn(`Port ${p} zaten kullanılıyor — ${attemptsLeft - 1} deneme kaldı. Portu ${p + 1} olarak deniyorum...`);
            // small delay before retry
            setTimeout(() => {
              tryListen(p + 1, attemptsLeft - 1).then(resolve).catch(reject);
            }, 200);
            return;
          }

          reject(err);
        });
    });
  }

  // return a promise to allow callers to await if desired
  return tryListen(port).catch((err) => {
    console.error('Sunucu başlatılamadı:', err);
    // rethrow so caller sees it
    throw err;
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer
};
