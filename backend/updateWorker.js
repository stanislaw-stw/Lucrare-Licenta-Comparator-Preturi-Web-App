const { parentPort, workerData } = require('worker_threads');
const { Client } = require('pg');
const moment = require('moment');
const { spawn } = require('child_process');

const connectionString = 'postgresql://comparatorpreturi_owner:1TqfrjXmV8DI@ep-long-dust-a2zj2nd7.eu-central-1.aws.neon.tech/comparatorpreturi?sslmode=require';

// func care compara 2 stringuri de cautare si returneaza true daca sunt identice
function areQueriesSimilar(query1, query2) {
    return query1.toLowerCase() === query2.toLowerCase();
}

//func care ruleaza un script python si returneaza un promise
//scriptul Python este executat fol spawn din child_process
function runPythonScript(scriptName, arg) {
    return new Promise((resolve, reject) => {
        const process = spawn(`./${scriptName}`, [arg]);

        //captureaza si afiseaza iesierea standard a scriptului
        process.stdout.on('data', (data) => {
            console.log(`Output from ${scriptName}: ${data}`);
        });

        //afis erorile scriptului
        process.stderr.on('data', (data) => {
            console.error(`Error from ${scriptName}: ${data}`);
        });

        //gestioneaza finalizarea procesului, rezolvand sau respingand promise-ul
        process.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${scriptName} process exited with code ${code}`));
            }
        });
    });
}

// func principala care gestioneaza actualizarea cautarilor in bd si rularea scripturilor
const updateSearchQueries = async (query, forceUpdate = "false") => {
    const client = new Client({
        connectionString,
        ssl: {
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();

        const now = moment();

        // selecteaza cautarile efec in ultimele 15 min si ver daca cautarea exista in bd
        const searchRows = await client.query('SELECT * FROM search_queries WHERE last_updated > NOW() - INTERVAL \'15 minutes\'');
        const existingRow = await client.query('SELECT * FROM search_queries WHERE query = $1', [query]);

        // actualizeaza timpestampul cautarii exis sau insereaza o noua cautare
        if (existingRow.rows.length > 0) {
            await client.query('UPDATE search_queries SET last_updated = NOW() WHERE query = $1', [query]);
        } else {
            await client.query('INSERT INTO search_queries (query) VALUES ($1)', [query]);
        }

        // un flag care deter daca este necesara actualizarea
        let updateNeeded = true;

        for (const row of searchRows.rows) {
            // ver daca exista cautari similare recente
            if (areQueriesSimilar(row.query, query)) {
                updateNeeded = false;
                break;
            }
        }

        // daca este necesara actualizarea sau daca este fortata, ruleaza scripturile
        if (updateNeeded || forceUpdate === "true") {
            console.log("Updating search queries")
            await Promise.all([
                runPythonScript('main', query),
                runPythonScript('cel', query)
            ]);
        }

        await client.end();
        parentPort.postMessage({ status: 'success' });
    } catch (err) {
        console.error('Error updating search queries:', err);
        parentPort.postMessage({ status: 'error', error: err.message });
    }
};

updateSearchQueries(workerData.query, workerData.forceUpdate);