const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        application: "TaskFlow API",
        status: "running"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "healthy"
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`TaskFlow API running on port ${PORT}`);
});