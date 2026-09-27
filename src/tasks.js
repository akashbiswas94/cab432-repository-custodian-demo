const express = require("express");

const router = express.Router();

const tasks = [
    {
        id: 1,
        title: "Complete CAB432 assignment",
        completed: false
    },
    {
        id: 2,
        title: "Prepare repository documentation",
        completed: false
    }
];

router.get("/", (req, res) => {
    res.json(tasks);
});

router.post("/", (req, res) => {
    const task = {
        id: tasks.length + 1,
        title: req.body.title,
        completed: false
    };

    tasks.push(task);

    res.status(201).json(task);
});

module.exports = router;