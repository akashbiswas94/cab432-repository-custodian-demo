function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            error: "Authentication required"
        });
    }

    const token = authHeader.replace("Bearer ", "");

    if (!token) {
        return res.status(401).json({
            error: "Invalid token"
        });
    }

    req.user = {
        id: 1,
        username: "demo-user"
    };

    next();
}

module.exports = authenticateUser;