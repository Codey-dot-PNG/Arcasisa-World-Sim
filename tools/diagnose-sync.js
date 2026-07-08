#!/usr/bin/env node
/**
 * diagnose-sync.js
 *
 * Diagnostic script to verify the Arcasia World Sim sync layer is working correctly.
 * Tests persistence, concurrency/CAS conflict handling, and read-your-writes guarantees.
 *
 * Usage:
 *   node tools/diagnose-sync.js https://your-app.vercel.app
 *
 * Zero dependencies; requires Node 18+ (for global fetch).
 * Exit code 0 = all tests passed; 1 = at least one failed; tests marked SKIPPED do not fail.
 */

const url = process.argv[2];
if (!url) {
  console.error('Usage: node tools/diagnose-sync.js <url>');
  process.exit(1);
}

const baseUrl = url.replace(/\/$/, '');
const results = {};
let registrationClosed = false;

async function request(method, path, body = null, cookies = '') {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies && { Cookie: cookies }),
    },
  };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(`${baseUrl}${path}`, opts);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    return {
      status: res.status,
      data,
      headers: Object.fromEntries(res.headers),
    };
  } catch (err) {
    throw new Error(`Request failed: ${err.message}`);
  }
}

function extractCookie(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const match = setCookie.match(/arcsid=([^;]+)/);
  return match ? `arcsid=${match[1]}` : '';
}

function log(test, status, message) {
  results[test] = { status, message };
  console.log(`[${status}] ${test}: ${message}`);
}

async function test1_config() {
  try {
    const res = await request('GET', '/api/config');
    if (res.status !== 200) {
      log('CONFIG', 'FAIL', `status ${res.status}`);
      return;
    }

    // /api/config: { storage: 'supabase'|'file', realtime: 'supabase'|'sse', ephemeral?: true }
    if (res.data?.ephemeral) {
      log('CONFIG', 'FAIL', `NO DATABASE CONFIGURED — file store on an ephemeral host. World resets on every cold start. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables and redeploy.`);
      return;
    }

    log('CONFIG', 'PASS', `storage=${res.data?.storage}, realtime=${res.data?.realtime}`);
  } catch (err) {
    log('CONFIG', 'FAIL', err.message);
  }
}

async function test2_persistence() {
  try {
    const username = `diag_${Date.now()}`;
    const password = Math.random().toString(36).slice(2);

    // Register
    const regRes = await request('POST', '/api/auth/register', {
      username,
      password,
    });

    if (regRes.status === 403) {
      log('PERSISTENCE', 'SKIPPED', 'Registration closed. Open registration in GM Studio to run this test.');
      registrationClosed = true;
      return;
    }

    if (regRes.status !== 200) {
      log('PERSISTENCE', 'FAIL', `register status ${regRes.status}`);
      return;
    }

    const cookie = extractCookie(regRes);
    if (!cookie) {
      log('PERSISTENCE', 'FAIL', 'No arcsid cookie after registration');
      return;
    }

    // Verify state
    const stateRes = await request('GET', '/api/state', null, cookie);
    if (stateRes.status !== 200 || !stateRes.data?.state) {
      log('PERSISTENCE', 'FAIL', `GET /api/state status ${stateRes.status}`);
      return;
    }

    const v1 = stateRes.data.v;
    if (typeof v1 !== 'number') {
      log('PERSISTENCE', 'FAIL', `world version is not a number: ${v1}`);
      return;
    }

    // Wait and re-login with fresh session
    await new Promise(resolve => setTimeout(resolve, 3000));

    const loginRes = await request('POST', '/api/auth/login', {
      username,
      password,
    });

    if (loginRes.status !== 200) {
      log('PERSISTENCE', 'FAIL', `re-login status ${loginRes.status}. Account did not persist.`);
      return;
    }

    log('PERSISTENCE', 'PASS', 'Account still exists on a fresh login 3s after registration');
  } catch (err) {
    log('PERSISTENCE', 'FAIL', err.message);
  }
}

async function test3_concurrency() {
  try {
    if (registrationClosed) {
      log('CONCURRENCY', 'SKIPPED', 'Registration closed (see PERSISTENCE test)');
      return;
    }

    const ts = Date.now();
    const password = Math.random().toString(36).slice(2);

    // Register 5 users in parallel
    const registerPromises = [];
    for (let i = 0; i < 5; i++) {
      registerPromises.push(
        request('POST', '/api/auth/register', {
          username: `diag_${ts}_${i}`,
          password,
        })
      );
    }

    const regResults = await Promise.all(registerPromises);
    const successful = regResults.filter(r => r.status === 200).length;
    const failed = regResults.filter(r => r.status !== 200 && r.status !== 403).length;

    if (successful < 5) {
      log('CONCURRENCY', 'FAIL', `Only ${successful}/5 parallel registrations succeeded. Possible lost-write: ${failed} failures.`);
      return;
    }

    // Login each one to verify they all persisted
    let loggedIn = 0;
    for (let i = 0; i < 5; i++) {
      const loginRes = await request('POST', '/api/auth/login', {
        username: `diag_${ts}_${i}`,
        password,
      });
      if (loginRes.status === 200) loggedIn++;
    }

    if (loggedIn === 5) {
      log('CONCURRENCY', 'PASS', '5/5 parallel registrations persisted and logged back in');
    } else {
      log('CONCURRENCY', 'FAIL', `Only ${loggedIn}/5 accounts persisted after CAS test`);
    }
  } catch (err) {
    log('CONCURRENCY', 'FAIL', err.message);
  }
}

async function test4_readYourWrites() {
  try {
    if (registrationClosed) {
      log('READ_YOUR_WRITES', 'SKIPPED', 'Registration closed (see PERSISTENCE test)');
      return;
    }

    const username1 = `diag_${Date.now()}_ryw1`;
    const username2 = `diag_${Date.now()}_ryw2`;
    const password = Math.random().toString(36).slice(2);

    // Register session 1
    const reg1 = await request('POST', '/api/auth/register', {
      username: username1,
      password,
    });

    if (reg1.status !== 200) {
      log('READ_YOUR_WRITES', 'FAIL', `session 1 registration failed: ${reg1.status}`);
      return;
    }

    const cookie1 = extractCookie(reg1);

    // Get initial state version
    const state1Res = await request('GET', '/api/state', null, cookie1);
    const v1 = state1Res.data?.v;

    // Register session 2 (this mutates the world)
    const reg2 = await request('POST', '/api/auth/register', {
      username: username2,
      password,
    });

    if (reg2.status !== 200) {
      log('READ_YOUR_WRITES', 'FAIL', `session 2 registration failed: ${reg2.status}`);
      return;
    }

    // Immediately fetch state with session 1 cookie (no delay)
    // The version should increase because session 2's mutation committed
    const state2Res = await request('GET', '/api/state', null, cookie1);
    const v2 = state2Res.data?.v;

    if (typeof v1 !== 'number' || typeof v2 !== 'number') {
      log('READ_YOUR_WRITES', 'FAIL', `version not a number: v1=${v1}, v2=${v2}`);
      return;
    }

    if (v2 > v1) {
      log('READ_YOUR_WRITES', 'PASS', `Version incremented after concurrent registration: ${v1} → ${v2}`);
    } else {
      log('READ_YOUR_WRITES', 'FAIL', `Version did not increase. v1=${v1}, v2=${v2}. Possible lost write or no CAS enforcement.`);
    }
  } catch (err) {
    log('READ_YOUR_WRITES', 'FAIL', err.message);
  }
}

async function main() {
  console.log(`\nArcasia Sync Diagnostics`);
  console.log(`Target: ${baseUrl}\n`);

  // Run tests sequentially
  await test1_config();
  await test2_persistence();
  await test3_concurrency();
  await test4_readYourWrites();

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const table = [];
  for (const [test, result] of Object.entries(results)) {
    table.push([test, result.status, result.message]);
  }

  // Simple table output
  const maxTest = Math.max(...table.map(r => r[0].length), 10);
  const maxStatus = 10;
  console.log(
    'TEST'.padEnd(maxTest) +
    ' | ' +
    'STATUS'.padEnd(maxStatus) +
    ' | MESSAGE'
  );
  console.log('-'.repeat(maxTest) + '-+-' + '-'.repeat(maxStatus) + '-+-' + '-'.repeat(40));
  for (const [test, status, message] of table) {
    console.log(
      test.padEnd(maxTest) +
      ' | ' +
      status.padEnd(maxStatus) +
      ' | ' +
      message.slice(0, 40)
    );
  }

  // Determine exit code
  const failed = Object.values(results).filter(r => r.status === 'FAIL').length;
  const passed = Object.values(results).filter(r => r.status === 'PASS').length;
  const skipped = Object.values(results).filter(r => r.status === 'SKIPPED').length;

  console.log('\n' + '='.repeat(70));
  console.log(`Results: ${passed} PASS, ${failed} FAIL, ${skipped} SKIPPED`);

  if (failed > 0) {
    console.log('\n⚠ At least one test failed. See above for details.');
    process.exit(1);
  } else {
    console.log('\n✓ All tests passed.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
