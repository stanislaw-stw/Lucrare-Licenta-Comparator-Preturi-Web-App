const express = require('express');
const { Client, Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');
const moment = require('moment');
const cors = require('cors');
const { Worker } = require('worker_threads');
const Mailgun = require('mailgun.js');
const formData = require('form-data');

// configurare mailgun fol api key
const mailgun = new Mailgun(formData);
const mg = mailgun.client({
    username: 'api',
    key: '4e648b93792e763af4c031cfd391d6d6-8a084751-86d6b4ee' // replace with your API key
});

const stringSimilarity = require('string-similarity');

const app = express();
app.use(express.json());
app.use(cors());

// conexiune la postgres
const connectionString = 'postgresql://comparatorpreturi_owner:1TqfrjXmV8DI@ep-long-dust-a2zj2nd7.eu-central-1.aws.neon.tech/comparatorpreturi?sslmode=require';

const pool = new Pool({
    connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

const SECRET_KEY = 'your_secret_key';

// func pt actualizarea cautarilor fol threaduri de lucru
const updateSearchQueriesMultiThreaded = (query, forceUpdate = "false") => {
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

//endpoint folosit pentru recuperarea parolei unui utilizator
//utilizator cere recuperarea parolei, endpointul va genera un token de resetare a parolei si va trimite un email utilizatorului cu un link pentru resetarea parolei
app.post('/recovery', async (req, res) => {
    const { username } = req.body; //cererea contine un JSON cu un camp username
    const client = await pool.connect();
    try {
        const userResult = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(404).send('User not found');
        }

        const user = userResult.rows[0];
        // generarea tokenului
        const resetToken = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '3m' });

        const emailData = {
            from: 'postmaster@sandbox3816587e136d40fe98d517db5aed2409.mailgun.org',
            to: username,
            subject: 'Recuperare Parolă',
            text: `Accesați acest link pentru a vă reseta parola: http://localhost:4000/resetPassword?resetToken=${resetToken}`
        };
        //fol mailgun pentru a trimite emailul
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
    } finally {
        client.release(); //elibereaza conex la bd sa nu ramana blocata
    }
});


//Acest endpoint este folosit pentru a cauta produse în baza de date pe baza unui cuv cheie furnizat de utilizator
//De asemenea, act inter de cautare intr-un mod asincron
app.get('/search', async (req, res) => {
    // le extrage din param url
    let { query, forceUpdate } = req.query;
    if (!query) return res.status(400).send('Missing search query');
    const client = await pool.connect();

    try {
        // imparte queryul in cuv separate si adauga caractrere wildcard pt a permite potriviri partiale in sql
        let searchTerms = query.split(/\s+/).map(term => `%${term}%`);
        let sqlQuery = 'SELECT * FROM products WHERE ' + searchTerms.map((_, i) => `(title ILIKE $${i + 1} OR subcategory ILIKE $${i + 1})`).join(' OR ');
        // construieste interogarea sql pt a cauta prod al coror titlu sau subcategorie contin oricare din termenii de cautare
        //ILIKE pentru o căutare case-insensitive

        const productsResult = await client.query(sqlQuery, searchTerms);
        const products = productsResult.rows;

        // map pt a stoca prod unice pe baza id
        const uniqueProductsMap = new Map();
        for (const product of products) {
            uniqueProductsMap.set(product.id, product);// daca exista prod cu ac id, doar ultima aparitie va fi pastrata
        }

        const uniqueProducts = Array.from(uniqueProductsMap.values());

        // ruleaza asincron func de actualizare a inter de cautare imediat ce bucla de even este disp
        setImmediate(() => {
            updateSearchQueriesMultiThreaded(query, forceUpdate).catch(err => console.error('Error updating search queries:', err));
        });

        res.json({ products: uniqueProducts }); // trim rasp catre clien cu prod unice gasite sub forma de json
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});

// endpoint fol pt a reseta parola fol un token de resetare si o parola noua furnizata
app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body; //Extrage token si newPassword din corpul cererii
    if (!token || !newPassword) return res.status(400).send('Missing token or new password');

    try {
        const decoded = jwt.verify(token, SECRET_KEY); //decodifica tokenul
        const userId = decoded.id;
        const hashedPassword = await bcrypt.hash(newPassword, 10); //decripteaza parolva cu bcrypt
        const client = await pool.connect();

        await client.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
        res.send('Password reset successfully');
    } catch (err) {
        res.status(500).send('Server error');
    }
});

//Acest endpoint este fol pentru a sterge un utilizator si toate datele asociate acestuia, folosind un token de autentificare
app.delete('/deleteUser', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).send('Missing token');

    const client = await pool.connect();

    try {
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        await client.query('DELETE FROM tokens WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM favorites WHERE user_id = $1', [userId])
        await client.query('DELETE FROM users WHERE id = $1', [userId]);

        res.send('User deleted successfully');
    } catch (err) {
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});

//acest endpoint returneaza ultimele 10 cautari efectuate, impreuna cu imaginea primului produs asociat fiecărei căutări
app.get('/recentSearches', async (req, res) => {
    const client = await pool.connect();

    try {
        const recentSearchesResult = await client.query('SELECT * FROM search_queries ORDER BY last_updated DESC LIMIT 10');
        const recentSearches = recentSearchesResult.rows;

        const searchesWithImages = await Promise.all(recentSearches.map(async (search) => {
           // pt fiecare cautare recenta executa o interogare pt a gasi primul prod al carui tilu contine termenul de cautare
            const productsResult = await client.query(
                'SELECT * FROM products WHERE title ILIKE $1 LIMIT 1',
                [`%${search.query}%`]
            );
            const product = productsResult.rows[0];
            return { //returneaza un obiect care contine term de cautare,data ultiei act si url ul imag
                query: search.query,
                last_updated: search.last_updated,
                product_image: product ? product.image_url : null
            };
        }));

        // trimite un rasp json care contine un array de oibiecte searchesWithImages
        res.json({ recentSearches: searchesWithImages });
    } catch (err) {
        console.error('Error fetching recent searches:', err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});


app.post('/changePassword', async (req, res) => {
    const { token, oldPassword, newPassword } = req.body;
    if (!token || !oldPassword || !newPassword) return res.status(400).send('Missing token, old password or new password');

    const client = await pool.connect();

    try {
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        const userResult = await client.query('SELECT password FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];

        const passwordIsValid = await bcrypt.compare(oldPassword, user.password);
        if (!passwordIsValid) {
            return res.status(401).send('Invalid old password');
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await client.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);

        res.send('Password changed successfully');
    } catch (err) {
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});

app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Missing username or password');

    const client = await pool.connect();

    try {
        const userCheck = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userCheck.rows.length > 0) {
            return res.status(409).send('Username already exists');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);

        res.status(201).send('User created successfully');
    } catch (err) {
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});


app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Missing username or password');

    const client = await pool.connect();

    try {
        const userResult = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userResult.rows.length === 0) {
            return res.status(401).send('Invalid username or password');
        }

        const user = userResult.rows[0];
        const passwordIsValid = await bcrypt.compare(password, user.password);
        if (!passwordIsValid) {
            return res.status(401).send('Invalid username or password');
        }

        const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
        await client.query('INSERT INTO tokens (user_id, token) VALUES ($1, $2)', [user.id, token]);

        res.json({ token });
    } catch (err) {
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});



//normalizeaza textul pt a permite compararea mai usoara a titlurilor
const normalizeText = (text) => {
    return text.toLowerCase().replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
};
// obtine cuv cheie din titlu pt a facilita compararea
const extractKeyIdentifiers = (title) => {
    const normalizedTitle = normalizeText(title);
    return normalizedTitle.split(' ');
};
// calc similitudinea dintre doua texte folosind string-similarity
const calculateSimilarity = (text1, text2) => {
    return stringSimilarity.compareTwoStrings(text1, text2);
};


//Acest endpoint primește un id de produs și returnează detalii despre produs, istoricul prețurilor și informații despre produse similare
app.get('/getItem', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).send('Missing item ID');

    const client = await pool.connect();

    try {
        const productResult = await client.query('SELECT * FROM products WHERE id = $1', [id]);
        if (productResult.rows.length === 0) {
            return res.status(404).send('Item not found');
        }
        const product = productResult.rows[0];

        const keyIdentifiers = extractKeyIdentifiers(product.title);
        const normalizedTitle = normalizeText(product.title);
        const priceHistoryResult = await client.query('SELECT * FROM price_history WHERE product_id = $1 ORDER BY date DESC', [id]);
        const priceHistory = priceHistoryResult.rows;
        let combinedPriceHistory = [...priceHistory];

        // executa o interogare pt a obtine toate prod cu exceptia celui specificat
        const allProductsResult = await client.query('SELECT * FROM products WHERE id != $1', [id]);
        const allProducts = allProductsResult.rows;
        console.log(allProducts);
        // filtreaza prod pt a gasi cele similare si aplicam o regula de similitudine care ne ajuta la lista de mag
        const similarProducts = allProducts.filter(p => {
            const normalizedSimilarTitle = normalizeText(p.title);
            return calculateSimilarity(normalizedTitle, normalizedSimilarTitle) > 0.88;
        });

        let additionalInfo = [];

        for (const similarProduct of similarProducts) {
            // exec o interogare pt a obtine istoricul preturilor
            const similarPriceHistoryResult = await client.query('SELECT * FROM price_history WHERE product_id = $1 ORDER BY date DESC', [similarProduct.id]);
            combinedPriceHistory = [...combinedPriceHistory, ...similarPriceHistoryResult.rows];

            // adauga inf despre prod sim
            additionalInfo.push({
                id: similarProduct.id,
                title: similarProduct.title,
                url: similarProduct.spec1,
                last_check: similarProduct.spec2,
                price: similarProduct.price,
                retailer: similarProduct.spec3
            });
        }

        // trim un rasp json care contine det despre prod, istoric combinat al pr si inf despre prod sim
        res.json({ product, combinedPriceHistory, additionalInfo });
    } catch (err) {
        console.error('Error querying the database:', err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});



app.get('/isFavorite', async (req, res) => {
    const { token, itemId } = req.query;
    if (!token || !itemId) return res.status(400).send('Missing token or itemId');

    const client = await pool.connect();

    try {
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        const favoriteResult = await client.query('SELECT * FROM favorites WHERE user_id = $1 AND item = $2', [userId, itemId]);

        if (favoriteResult.rows.length > 0) {
            res.json({ isFavorite: true });
        } else {
            res.json({ isFavorite: false });
        }
    } catch (err) {
        console.error('Error checking favorite status:', err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});


app.post('/logout', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).send('Missing token');

    const client = await pool.connect();

    try {
        await client.query('DELETE FROM tokens WHERE token = $1', [token]);
        res.send('Logged out successfully');
    } catch (err) {
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});


app.delete('/removeFavorite', async (req, res) => {
    const { token, itemId } = req.body;
    if (!token || !itemId) return res.status(400).send('Missing token or itemId');

    const client = await pool.connect();

    try {
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        await client.query('DELETE FROM favorites WHERE user_id = $1 AND item = $2', [userId, itemId]);

        res.status(200).send('Favorite removed successfully');
    } catch (err) {
        console.error('Error removing favorite:', err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});


app.post('/setFavorite', async (req, res) => {
    const { token, item } = req.body;
    if (!token || !item) return res.status(400).send('Missing token or item');

    const client = await pool.connect();

    try {
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            return res.status(401).send('Invalid token');
        }
        const userId = tokenResult.rows[0].user_id;
        await client.query('INSERT INTO favorites (user_id, item) VALUES ($1, $2)', [userId, item.id]);

        res.send('Item added to favorites');
    } catch (err) {
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});

app.get('/getFavorites', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token');

    const client = await pool.connect();

    try {
        const tokenResult = await client.query('SELECT user_id FROM tokens WHERE token = $1', [token]);
        if (tokenResult.rows.length === 0) {
            return res.status(401).send('Invalid token');
        }

        const userId = tokenResult.rows[0].user_id;
        const favorites = await client.query(`
            SELECT p.id, p.title, p.price, p.image_url 
            FROM favorites f
            JOIN products p ON f.item = p.id 
            WHERE f.user_id = $1
        `, [userId]);

        res.json({ favorites: favorites.rows });
    } catch (err) {
        console.error('Error fetching favorites:', err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});


//Acest endpoint primeste detalii despre un produs si il adauga sau act in baza de date
//De asemenea, act istoricul preturilor si trimite emailuri utilizatorilor care au produsul în lista lor de favorite daca pretul s-a schimbat
app.post('/addProduct', async (req, res) => {
    const {
        title, spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10,
        spec11, spec12, spec13, spec14, spec15, image_url, category, subcategory, price
    } = req.body;

    if (!title || !price) return res.status(400).send('Missing required fields');

    let parsedPrice = price;
    try {
        parsedPrice = parseFloat(price.replace(/[^0-9.-]+/g, ""));
    } catch {}

    if (isNaN(parsedPrice)) return res.status(400).send('Invalid price format');

    const client = await pool.connect();

    try {
        //inter pt a ver daca exista deja un prod cu ac titlu in bd
        const existingProductResult = await client.query('SELECT id, price FROM products WHERE title = $1', [title]);

        // daca ex atunci luam id ul si pretul
        if (existingProductResult.rows.length > 0) {
            const existingProductId = existingProductResult.rows[0].id;
            const existingPrice = existingProductResult.rows[0].price;

            // actualizam detaliile prod existent in bd
            await client.query(
                'UPDATE products SET spec1 = $1, spec2 = $2, spec3 = $3, spec4 = $4, spec5 = $5, spec6 = $6, spec7 = $7, spec8 = $8, spec9 = $9, spec10 = $10, spec11 = $11, spec12 = $12, spec13 = $13, spec14 = $14, spec15 = $15, image_url = $16, category = $17, subcategory = $18, price = $19 WHERE id = $20',
                [spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10, spec11, spec12, spec13, spec14, spec15, image_url, category, subcategory, parsedPrice, existingProductId]
            );

            // ver daca pretul prod s a schimb si adauga un nou record in tabelul price_history pt a reflecta noul pret
            if (existingPrice !== parsedPrice) {
                await client.query('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [existingProductId, parsedPrice]);

                //luam util care au adaugat prod cu pret schimbat
                const favoriteUsersResult = await client.query(
                    'SELECT u.username FROM favorites f JOIN users u ON f.user_id = u.id WHERE f.item = $1',
                    [existingProductId]
                );

                // creeaza o promisiune pt a trim emailurile de notificare pe ac logica cu mailgun
                const emailPromises = favoriteUsersResult.rows.map(user => {
                    const emailData = {
                        from: 'postmaster@sandbox3816587e136d40fe98d517db5aed2409.mailgun.org',
                        to: user.username,
                        subject: 'S-a schimbat prețul produsului tau favorit!',
                        text: `Pretul produsului "${title}" a fost schimbat de la ${existingPrice} la ${parsedPrice}.`
                    };
                    return mg.messages.create('sandbox3816587e136d40fe98d517db5aed2409.mailgun.org', emailData)
                        .then(msg => console.log('Email sent: ' + msg))
                        .catch(err => console.error('Email error:', err));
                });

                await Promise.all(emailPromises);
            }

            res.status(200).send('Product updated successfully');
        } else {
            // daca prod nu exista deja, insereaza un nou prod in tabela products si returneaza id ul acestuia
            const result = await client.query(
                'INSERT INTO products (title, spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10, spec11, spec12, spec13, spec14, spec15, image_url, category, subcategory, price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id',
                [title, spec1, spec2, spec3, spec4, spec5, spec6, spec7, spec8, spec9, spec10, spec11, spec12, spec13, spec14, spec15, image_url, category, subcategory, parsedPrice]
            );

            const productId = result.rows[0].id;

            // la fel trb pt un produs nou sa bagam pretul in tab price history
            await client.query('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [productId, parsedPrice]);

            res.status(201).send('Product added successfully');
        }
    } catch (err) {
        console.error('Error adding or updating product:', err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});

app.get('/runScript', (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).send('Missing query parameter');

    const pythonProcess = spawn('python3', ['main.py', query]);

    pythonProcess.on('close', (code) => {
        console.log(`Python script exited with code ${code}`);
        res.send(`Python script executed with query: ${query}`);
    });
});

app.get('/yolo', (req, res) => {
    yo = 'balarii';
    res.json({ favorites: yo });
});

app.listen(80, () => {
    console.log('Server is running on port 80');
});
