Sentry.onLoad(function () {
  Sentry.init({
    dsn: 'https://175ba7b56a443dace10ed1bb8ef8e880@o4511618478047232.ingest.us.sentry.io/4511618490761216',
    environment: 'production',
    tracesSampleRate: 0.1,
  });
});
