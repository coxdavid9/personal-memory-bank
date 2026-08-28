const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));

// Express 5 no longer accepts the old '*' route pattern.
// Serve the SPA entry point for any non-file route.
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => console.log(`Memory Bank running on ${port}`));
