const express = require('express');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');
const moment = require('moment');
const cors = require('cors');
const natural = require('natural');
const { Worker } = require('worker_threads');
const Mailgun = require('mailgun.js');
const formData = require('form-data');

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
    username: 'api',
    key: '4e648b93792e763af4c031cfd391d6d6-8a084751-86d6b4ee'
});
const stringSimilarity = require('string-similarity');
const _ = require('lodash');

const app = express();
app.use(express.json());
app.use(cors());
const connectionString = 'postgresql://comparatorpreturi_owner:1TqfrjXmV8DI@ep-long-dust-a2zj2nd7.eu-central-1.aws.neon.tech/comparatorpreturi?sslmode=require';
let currentUpdateProcess = null;

const SECRET_KEY = 'your_secret_key';

app.post('/recovery', async (req, res) => {
    const { username } = req.body;

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const userResult = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            await client.end();
            return res.status(404).send('User not found');
        }

        const user = userResult.rows[0];
        const resetToken = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });

        const emailData = {
            from: 'postmaster@sandbox3816587e136d40fe98d517db5aed2409.mailgun.org',
            to: username,
            subject: 'Recuperare Parolă',
            text: `Accesați acest link pentru a vă reseta parola: http://localhost:4000/resetPassword?resetToken=${resetToken}`
        };

        mg.messages.create('sandbox3816587e136d40fe98d517db5aed2409.mailgun.org', emailData)
            .then((msg) => {
                console.log('Email trimis: ' + msg);
                res.status(200).send('Email trimis cu succes');
            })
            .catch((err) => {
                console.error('Email error:', err);
                res.status(500).send('Eroare la trimiterea emailului');
            });

        await client.end();
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).send('Server error');
    }
});

app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).send('Missing token or new password');

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const userId = decoded.id;

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        const client = new Client({
            connectionString,
            ssl: {
                rejectUnauthorized: false
            }
        });

        await client.connect();
        await client.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
        await client.end();

        res.send('Password reset successfully');
    } catch (err) {
        res.status(500).send('Server error');
    }
});




function areQueriesSimilar(query1, query2) {
    return query1.toLowerCase() === query2.toLowerCase();
}

function runPythonScript(scriptName, arg) {
    return new Promise((resolve, reject) => {
        const process = spawn(`./${scriptName}`, [arg]);

        process.stdout.on('data', (data) => {
            console.log(`Output from ${scriptName}: ${data}`);
        });

        process.stderr.on('data', (data) => {
            console.error(`Error from ${scriptName}: ${data}`);
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${scriptName} process exited with code ${code}`));
            }
        });
        currentUpdateProcess = process;

    });
}

const updateSearchQueriesMultiThreaded = (query, forceUpdate = false) => {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./updateWorker.js', {
            workerData: { query, forceUpdate }
        });

        worker.on('message', (message) => {
            if (message.status === 'success') {
                resolve();
            } else {
                reject(new Error(message.error));
            }
        });

        worker.on('error', (error) => {
            reject(error);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });
    });
};



app.delete('/deleteUser', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).send('Missing token');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            await client.end();
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
        await client.end();

        res.send('User deleted successfully');
    } catch (err) {
        res.status(500).send('Server error');
    }
});

// Change password endpoint
app.post('/changePassword', async (req, res) => {
    const { token, oldPassword, newPassword } = req.body;
    if (!token || !oldPassword || !newPassword) return res.status(400).send('Missing token, old password or new password');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            await client.end();
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        const userResult = await client.query('SELECT password FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];

        const passwordIsValid = await bcrypt.compare(oldPassword, user.password);
        if (!passwordIsValid) {
            await client.end();
            return res.status(401).send('Invalid old password');
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await client.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
        await client.end();

        res.send('Password changed successfully');
    } catch (err) {
        res.status(500).send('Server error');
    }
});

// Signup endpoint
app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Missing username or password');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();

        // Check if the username already exists
        const userCheck = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userCheck.rows.length > 0) {
            await client.end();
            return res.status(409).send('Username already exists');
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert the new user into the database
        await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
        await client.end();

        res.status(201).send('User created successfully');
    } catch (err) {
        res.status(500).send('Server error');
    }
});

// Login endpoint
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Missing username or password');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const userResult = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            await client.end();
            return res.status(401).send('Invalid username or password');
        }

        const user = userResult.rows[0];
        const passwordIsValid = await bcrypt.compare(password, user.password);
        if (!passwordIsValid) {
            await client.end();
            return res.status(401).send('Invalid username or password');
        }

        const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
        await client.query('INSERT INTO tokens (user_id, token) VALUES ($1, $2)', [user.id, token]);
        await client.end();

        res.json({ token });
    } catch (err) {
        res.status(500).send('Server error');
    }
});

const normalizeText = (text) => {
    return text.toLowerCase().replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
};

// Utility function to extract key identifiers from a product title
const extractKeyIdentifiers = (title) => {
    const normalizedTitle = normalizeText(title);
    return normalizedTitle.split(' ');
};
const calculateSimilarity = (text1, text2) => {
    return stringSimilarity.compareTwoStrings(text1, text2);
};


app.get('/getItem', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).send('Missing item ID');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();

        const productResult = await client.query('SELECT * FROM products WHERE id = $1', [id]);
        if (productResult.rows.length === 0) {
            await client.end();
            return res.status(404).send('Item not found');
        }
        const product = productResult.rows[0];

        const keyIdentifiers = extractKeyIdentifiers(product.title);
        const normalizedTitle = normalizeText(product.title);

        const priceHistoryResult = await client.query('SELECT * FROM price_history WHERE product_id = $1 ORDER BY date DESC', [id]);
        const priceHistory = priceHistoryResult.rows;

        let combinedPriceHistory = [...priceHistory];

        const allProductsResult = await client.query('SELECT * FROM products WHERE id != $1', [id]);
        const allProducts = allProductsResult.rows;

        const similarProducts = allProducts.filter(p => {
            const normalizedSimilarTitle = normalizeText(p.title);
            return calculateSimilarity(normalizedTitle, normalizedSimilarTitle) > 0.88;  // Adjust the threshold as needed
        });

        let additionalInfo = [];

        for (const similarProduct of similarProducts) {
            const similarPriceHistoryResult = await client.query('SELECT * FROM price_history WHERE product_id = $1 ORDER BY date DESC', [similarProduct.id]);
            combinedPriceHistory = [...combinedPriceHistory, ...similarPriceHistoryResult.rows];

            additionalInfo.push({
                title: similarProduct.title,
                url: similarProduct.spec1,
                last_check: similarProduct.spec2,
                price: similarProduct.price,
                retailer: similarProduct.spec3
            });
        }

        await client.end();

        res.json({ product, combinedPriceHistory, additionalInfo });
    } catch (err) {
        console.error('Error querying the database:', err);
        res.status(500).send('Server error');
    }
});


app.post('/logout', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).send('Missing token');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        await client.query('DELETE FROM tokens WHERE token = $1', [token]);
        await client.end();

        res.send('Logged out successfully');
    } catch (err) {
        res.status(500).send('Server error');
    }
});

app.delete('/removeFavorite', async (req, res) => {
    console.log('removeFavorite')
    const { token, itemId } = req.body;
    console.log(token, itemId)
    if (!token || !itemId) return res.status(400).send('Missing token or itemId');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            await client.end();
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        await client.query('DELETE FROM favorites WHERE user_id = $1 AND item = $2', [userId, itemId]);

        await client.end();
        res.status(200).send('Favorite removed successfully');
    } catch (err) {
        console.error('Error removing favorite:', err);
        res.status(500).send('Server error');
    }
});

// Set favorite endpoint
app.post('/setFavorite', async (req, res) => {
    const { token, item } = req.body;
    if (!token || !item) return res.status(400).send('Missing token or item');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            await client.end();
            return res.status(401).send('Invalid token');
        }
        const userId = tokenResult.rows[0].user_id;
        await client.query('INSERT INTO favorites (user_id, item) VALUES ($1, $2)', [userId, item.id]);
        await client.end();

        res.send('Item added to favorites');
    } catch (err) {
        res.status(500).send('Server error');
    }
});

// Get favorites endpoint
app.get('/getFavorites', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            await client.end();
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        const favorites = await client.query(`
            SELECT p.id, p.title, p.price, p.image_url 
            FROM favorites f
            JOIN products p ON f.item = p.id 
            WHERE f.user_id = $1
        `, [userId]);

        await client.end();

        res.json({ favorites: favorites.rows });
    } catch (err) {
        console.error('Error fetching favorites:', err);
        res.status(500).send('Server error');
    }
});


const updateSearchQueries = async (query, forceUpdate=false) => {
    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();

        const now = moment();

        const searchRows = await client.query('SELECT * FROM search_queries WHERE last_updated > NOW() - INTERVAL \'15 minutes\'');
        const existingRow = await client.query('SELECT * FROM search_queries WHERE query = $1', [query]);
        if (existingRow.rows.length > 0) {
            await client.query('UPDATE search_queries SET last_updated = NOW() WHERE query = $1', [query]);
        } else {
            await client.query('INSERT INTO search_queries (query) VALUES ($1)', [query]);
        }

        let updateNeeded = true;

        for (const row of searchRows.rows) {
            if (areQueriesSimilar(row.query, query)) {
                    updateNeeded = false;
                    break;
            }
        }
        if (updateNeeded || forceUpdate === "true") {
            if (currentUpdateProcess) {
                currentUpdateProcess.kill();
                currentUpdateProcess = null;
            }
            await Promise.all([
                runPythonScript('main', query),
                runPythonScript('cel', query)
            ]);
        }

        await client.end();
    } catch (err) {
        console.error('Error updating search queries:', err);
    }
};
// Search endpoint
app.get('/search', async (req, res) => {
    let { query, forceUpdate } = req.query;
    if (!query) return res.status(400).send('Missing search query');
    if(forceUpdate === undefined) {
        forceUpdate = false;
    }

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();

        // Perform the search
        let sqlQuery = 'SELECT * FROM products WHERE title ILIKE $1';
        let params = [`%${query}%`];

        const products = await client.query(sqlQuery, params);
        await client.end();

        setImmediate(() => {
            updateSearchQueriesMultiThreaded(query, forceUpdate).catch(err => console.error('Error updating search queries:', err));
        });
        res.json({ products: products.rows });


    } catch (err) {
        res.status(500).send('Server error');
        console.error('Server error:', err);
    }
});

app.post('/addProduct', async (req, res) => {
    const { title, spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10, spec11, spec12, spec13,spec14,spec15, image_url, category, subcategory, price } = req.body;

    if (!title || !price) return res.status(400).send('Missing required fields');

    let parsedPrice = price;
    try {
        parsedPrice = parseFloat(price.replace(/[^0-9.-]+/g, ""));
    } catch {
    }

    if (isNaN(parsedPrice)) return res.status(400).send('Invalid price format');

    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();

        // Check if the product already exists
        const existingProductResult = await client.query('SELECT id, price FROM products WHERE title = $1', [title]);

        if (existingProductResult.rows.length > 0) {
            // Product exists, update it
            const existingProductId = existingProductResult.rows[0].id;
            const existingPrice = existingProductResult.rows[0].price;

            await client.query(
                'UPDATE products SET spec1 = $1, spec2 = $2, spec3 = $3, spec4 = $4, spec5 = $5, spec6 = $6, spec7 = $7, spec8 = $8, spec9 = $9, spec10 = $10, spec11 = $11, spec12 = $12, spec13 = $13, spec14=$14,spec15=$15, image_url = $16, category = $17, subcategory = $18, price = $19 WHERE id = $20',
                [spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10, spec11, spec12, spec13, spec14,spec15, image_url, category, subcategory, parsedPrice, existingProductId]
            );

            // Update the price history only if the price has changed
            if (existingPrice !== parsedPrice) {
                await client.query('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [existingProductId, parsedPrice]);
            }

            res.status(200).send('Product updated successfully');
        } else {
            // Product does not exist, insert a new one
            const result = await client.query(
                'INSERT INTO products (title, spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10, spec11, spec12, spec13, spec14, spec15, image_url, category, subcategory, price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id',
                [title, spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10, spec11, spec12, spec13,spec14, spec15, image_url, category, subcategory, parsedPrice]
            );

            const productId = result.rows[0].id;

            // Insert the initial price into the price_history table
            await client.query('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [productId, parsedPrice]);

            res.status(201).send('Product added successfully');
        }

        await client.end();
    } catch (err) {
        console.error('Error adding or updating product:', err);
        res.status(500).send('Server error');
    }
});
app.get('/runScript', (req, res) => {
const { query } = req.query;
if (!query) return res.status(400).send('Missing query parameter');

const pythonProcess = spawn('python3', ['main.py', query]);


pythonProcess.on('close', (code) => {
    console.log('Python script exited with code ${code}');
    res.send('Python script executed with query: ${query}');
});
});



app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
const email = "";
const nume = "";
