


import express from "express";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Hello, World!");
});


app.get("/health", (req, res) => {
    res.send("Hello, World!");
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});