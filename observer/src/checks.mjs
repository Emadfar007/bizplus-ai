import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const assert = (code, expected, actual, passed) => ({ code, expected, actual: String(actual).slice(0, 250), passed });
const diagnosis = (summary, causes, solutions, certainty = 'unconfirmed') => ({ summary, certainty, causes, solutions });
const check = (key, label, started, assertions, evidence, explanation, monitorError = false) => ({
  id: randomUUID(), key, label, completedAt: new Date().toISOString(), durationMs: Date.now() - started,
  status: monitorError ? 'monitor_error' : assertions.every(item => item.passed) ? 'passed' : 'failed',
  assertions, evidence, diagnosis: explanation,
});

export async function fixedRequest(origin, path, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}${path}`, { ...options, signal: controller.signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new Error('Redirects are not followed by this fixed-origin observer.');
    let total = 0; const chunks = [];
    for await (const chunk of response.body ?? []) {
      total += chunk.length;
      if (total > 512000) { controller.abort(); throw new Error('Observer response limit exceeded.'); }
      chunks.push(chunk);
    }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  } finally { clearTimeout(timer); }
}

export async function httpCheck(origin, key, path, timeoutMs = 12000) {
  const started = Date.now(); const label = { availability: 'Independent availability', readiness: 'Database readiness', storefront: 'Storefront document' }[key];
  try {
    const response = await fixedRequest(origin, path, {}, timeoutMs);
    const assertions = [assert('HTTP_STATUS', 'HTTP 200', response.status, response.status === 200), assert('RESPONSE_PRESENT', 'Non-empty response body', `${Buffer.byteLength(response.body)} bytes`, response.body.trim().length > 0)];
    if (key === 'availability') {
      let applicationHealthy = false;
      try {
        const payload = JSON.parse(response.body);
        applicationHealthy = payload.status === 'ok' && payload.app === 'BizPlus AI';
      } catch { /* A proxy HTML page is not application liveness. */ }
      assertions.push(assert('APPLICATION_HEALTH', 'JSON status ok and app BizPlus AI', applicationHealthy ? 'BizPlus AI reports status ok' : 'Expected application health JSON missing or invalid', applicationHealthy));
    }
    const dependencyFailures = [];
    if (key === 'readiness' && response.status === 200) {
      let ready = false;
      try { ready = ['ready', 'ok'].includes(JSON.parse(response.body).status); } catch { /* Missing readiness JSON is a failed contract. */ }
      assertions.push(assert('DEPENDENCY_READINESS', 'Readiness status ready after database probe', ready ? 'ready' : 'Readiness did not return ready status', ready));
    }
    if (key === 'readiness') {
      let components = [];
      try { components = JSON.parse(response.body).components ?? []; } catch { /* Malformed readiness is already a failed contract. */ }
      for (const component of Array.isArray(components) ? components.slice(0, 6) : []) {
        const name = String(component.name ?? 'dependency').replace(/[^a-z0-9_]/gi, '').slice(0, 40);
        const code = String(component.code ?? 'UNKNOWN').replace(/[^a-z0-9_]/gi, '').slice(0, 60);
        const message = String(component.message ?? '').replace(/(bearer\s+|token[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 160);
        assertions.push(assert(`READINESS_${name.toUpperCase()}`, 'Dependency probe passed', `${component.status} (${code}): ${message}`, component.status === 'passed'));
        if (component.status !== 'passed') dependencyFailures.push(`Readiness explicitly reports ${name} probe failure (${code}): ${message}. This confirms the failing component, but does not prove its underlying cause.`);
      }
    }
    if (key === 'storefront') assertions.push(assert('EXPECTED_CONTENT', 'BizPlus storefront HTML shell', /BizPlus/i.test(response.body) && /id=["']root["']/.test(response.body) ? 'Expected HTML shell present' : 'Expected HTML shell missing', /BizPlus/i.test(response.body) && /id=["']root["']/.test(response.body)));
    const passed = assertions.every(item => item.passed);
    return check(key, label, started, assertions, [`Observed ${path}: HTTP ${response.status}, ${Buffer.byteLength(response.body)} response bytes.`], passed
      ? diagnosis('The independently observed contract passed.', [], [])
      : diagnosis(key === 'readiness' ? 'The dependency readiness contract failed.' : 'The independently requested endpoint failed its contract.',
          dependencyFailures.length ? dependencyFailures : response.status === 503 && key === 'readiness' ? ['The readiness endpoint reports an unavailable dependency. The exact underlying database cause needs server logs.'] : [response.status === 404 ? 'The configured route may be absent or an incorrect deployment may be serving it.' : response.status >= 500 ? 'The application, proxy, or a dependency may be failing; HTTP status alone does not confirm the root cause.' : 'The endpoint returned unexpected status or content.'],
          ['Inspect deployment, dependency, and application logs at this check time.', key === 'readiness' ? 'Restore database connectivity and configuration, then rerun the readiness and synthetic journey checks.' : 'Restore the expected route and response, then verify a passing independent check.']));
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    const inspectionFailure = ['Redirects are not followed by this fixed-origin observer.', 'Observer response limit exceeded.'].includes(error?.message);
    if (inspectionFailure) return check(key, label, started, [assert('OBSERVER_INSPECTION', 'Response fits the fixed-origin observer policy', error.message, false)], [`${path}: ${error.message}`],
      diagnosis('The observer could not inspect this response under its bounded policy; website failure is not established.', ['The endpoint redirected or returned a response larger than the observer limit.'], ['Point the configured site at its canonical origin and preserve direct fixed routes.', 'Reduce the inspected response size or adjust the bounded observer policy after review, then recheck.'], 'confirmed'), true);
    const networkCode = typeof error?.cause?.code === 'string' ? error.cause.code.replace(/[^A-Z0-9_]/g, '').slice(0, 60) : '';
    const networkExplanation = /CERT|TLS|SSL/.test(networkCode) ? 'The TLS connection failed validation; certificate configuration needs inspection.' : /ENOTFOUND|EAI_/.test(networkCode) ? 'The configured hostname could not be resolved from this observer.' : /ECONNREFUSED/.test(networkCode) ? 'The target did not accept a connection from this observer.' : 'The application may be offline, waking from hosting sleep, unreachable, or waiting on a slow dependency.';
    return check(key, label, started, [assert('REQUEST_COMPLETED', `Response within ${timeoutMs / 1000} seconds`, timeout ? 'Request deadline exceeded' : 'Request did not complete', false)], [`${path}: ${timeout ? 'Timed out' : 'Connection or fixed-route inspection failed'}.`],
      diagnosis('The independent observer could not complete the website request.', [`${networkExplanation}${networkCode ? ` Observed network code: ${networkCode}.` : ''} This external check cannot prove the underlying production cause.`], ['Check hosting service state, DNS/TLS, recent deploys, and dependency latency.', 'Restore service availability, then verify this check and the business journey pass.']));
  }
}

export function browserCheck(result, key, label, started) {
  const failed = result.assertions.filter(item => !item.passed);
  const explanation = result.monitorError
    ? diagnosis('The observer browser runtime failed; website behavior was not verified.', ['Chromium is unavailable or the observer has insufficient runtime resources.'], ['Install the pinned Playwright browser image or Chromium runtime.', 'Check observer logs and memory, then rerun the browser journey.'], 'confirmed')
    : failed.length
      ? diagnosis('The actual browser journey failed a visible user outcome.', [`Failed browser assertions: ${failed.map(item => item.code).join(', ')}. Browser/network evidence may identify a failing request; server logs are needed to confirm its underlying cause.`], ['Inspect uncaught JavaScript errors and failed endpoint evidence.', 'Restore button handlers, authentication, catalog/dependency access, or confirmation behavior as indicated, then rerun the same journey.'])
      : diagnosis('The actual browser journey passed.', [], []);
  return check(key, label, started, result.assertions, result.evidence, explanation, result.monitorError);
}

export async function syntheticCheck(origin, sessionId, timeoutMs = 12000) {
  const started = Date.now(); const evidence = []; const assertions = [];
  const headers = { 'Content-Type': 'application/json', 'X-Demo-Session': sessionId };
  try {
    const deadline = Date.now() + 20000;
    const queued = await fixedRequest(origin, '/api/runs', { method: 'POST', headers, body: JSON.stringify({ workflowId: 'commerce-checkout', scenario: 'healthy' }) }, timeoutMs);
    if (queued.status !== 202) throw new Error('Synthetic workflow could not be scheduled.');
    const id = JSON.parse(queued.body).runId;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Synthetic workflow returned an invalid run ID.');
    let run;
    do {
      await delay(250);
      const fetched = await fixedRequest(origin, `/api/runs/${id}`, { headers }, Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
      if (fetched.status !== 200) throw new Error('Synthetic workflow could not be inspected.');
      run = JSON.parse(fetched.body);
    } while (['queued', 'running'].includes(run.status) && Date.now() < deadline);
    assertions.push(assert('SYNTHETIC_JOURNEY', 'Login, inventory, cart, synthetic checkout and confirmed order all pass', run.status, run.status === 'passed'));
    const canonicalSteps = ['login', 'inventory', 'cart', 'checkout', 'confirmation'];
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const ids = steps.map(step => String(step?.id ?? 'missing'));
    const contractPassed = ids.length === canonicalSteps.length && new Set(ids).size === canonicalSteps.length && canonicalSteps.every(id => ids.includes(id));
    assertions.push(assert('SYNTHETIC_STEP_CONTRACT', 'Exactly the five canonical workflow steps', JSON.stringify(ids), contractPassed));
    for (const step of steps.slice(0, 5)) assertions.push(assert(`SYNTHETIC_${String(step?.id ?? 'MISSING').toUpperCase()}`, 'Step passed', step?.status ?? 'missing', step?.status === 'passed'));
    assertions.push(assert('SYNTHETIC_PAYMENT_COUNT', 'Exactly one simulated payment; no provider charge', run.paymentCount, run.paymentCount === 1));
    evidence.push('Ran the fixed healthy sandbox workflow in the independent observer’s dedicated synthetic session. No provider payment or real commerce order was created.');
  } catch {
    assertions.push(assert('SYNTHETIC_JOURNEY', 'Completed healthy synthetic journey', 'The synthetic workflow did not complete successfully within its deadline', false));
    evidence.push('The synthetic API journey failed to schedule or finish. Inspect application workflow and database evidence.');
  }
  return check('synthetic_workflow', 'Synthetic login to order journey', started, assertions, evidence,
    assertions.every(item => item.passed) ? diagnosis('The synthetic business workflow passed.', [], []) : diagnosis('The synthetic business workflow failed even though transport may still be available.', ['Authentication, catalog data, checkout, confirmation, or database storage may have failed. These assertions narrow the failing stage; underlying causes require application evidence.'], ['Inspect the failed synthetic step and related database logs.', 'Restore the dependency or workflow stage, then verify all five steps and the original synthetic payment count.']));
}
