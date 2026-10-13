import type { LiveDiagnosis, LiveFault, LiveRun } from '@bizplus/shared';

const explanations: Record<Exclude<LiveFault, 'healthy'>, { category: string; cause: string; solutions: string[] }> = {
  http_500: { category: 'server_error', cause: 'The isolated response handler deliberately returned HTTP 500.', solutions: ['Remove the controlled HTTP 500 response and verify the same URL again.', 'For a real server error, inspect the application exception and correlated request logs; correct the failing code or dependency before deploying.'] },
  http_503: { category: 'service_unavailable', cause: 'The isolated response handler deliberately returned HTTP 503.', solutions: ['Remove the controlled HTTP 503 response and verify the same URL again.', 'For a real outage, inspect service readiness, capacity, maintenance and upstream dependency logs; restore readiness before routing traffic.'] },
  not_found: { category: 'missing_route', cause: 'The isolated response handler deliberately replaced the test route with HTTP 404.', solutions: ['Restore the controlled test route and verify the same URL again.', 'For a real missing route, check its configured URL, deployment routing and reverse proxy rules.'] },
  missing_content: { category: 'missing_content', cause: 'The isolated test page deliberately omitted the required content marker.', solutions: ['Restore the expected content marker and verify it is present in a new response.', 'For a real page, inspect template rendering, data-loading errors and unintended redirects; update the assertion only if the product requirement changed.'] },
  empty_body: { category: 'empty_response', cause: 'The isolated response handler deliberately sent HTTP 200 with an empty body.', solutions: ['Restore the response body and verify its status, content and byte count.', 'For a real page, inspect early response termination, template rendering and proxy/cache behavior.'] },
  timeout: { category: 'timeout', cause: 'The isolated response handler deliberately delayed its response for 13.5 seconds, exceeding the 12-second monitoring deadline.', solutions: ['Remove the controlled response delay and verify a completed response within 12 seconds.', 'For a real timeout, inspect slow requests, database queries, dependency latency and worker saturation; fix the bottleneck before increasing timeouts.'] },
  javascript_error: { category: 'javascript_error', cause: 'The isolated page deliberately threw a JavaScript error during initialization.', solutions: ['Remove the controlled JavaScript throw and repeat the actual browser journey.', 'For a real page, use the recorded page error and source maps to fix the exception, then verify the affected interactions.'] },
  button_broken: { category: 'broken_interaction', cause: 'The isolated page deliberately omitted its button event handlers.', solutions: ['Restore the controlled button event handlers and repeat sign-in, add-to-cart and confirmation.', 'For a real page, inspect handler registration, disabled controls and JavaScript initialization, then verify the resulting UI state.'] },
  login_401: { category: 'authentication', cause: 'The isolated synthetic sign-in endpoint deliberately returned HTTP 401.', solutions: ['Restore the controlled synthetic sign-in response and verify the browser reaches Signed in.', 'For a real sign-in failure, inspect the auth response, token/session expiry, cookie settings and account permissions without exposing credentials.'] },
  payment_unavailable: { category: 'payment_dependency', cause: 'The isolated synthetic confirmation endpoint deliberately returned HTTP 503. No payment was attempted.', solutions: ['Restore the controlled synthetic confirmation response and verify Order confirmed with zero real payments.', 'For a real payment failure, inspect provider status and request logs, reconcile the original transaction and preserve its idempotency key before retrying.'] },
  database_unavailable: { category: 'database_dependency', cause: 'The isolated catalog endpoint deliberately emulated a database dependency outage with HTTP 503; the real database remained untouched.', solutions: ['Restore the controlled synthetic catalog response and verify that add-to-cart shows one item.', 'For a real dependency failure, inspect database connectivity, connection pools, migrations and query errors; restore the dependency before repeating the journey.'] },
};

export function diagnoseLiveRun(run: LiveRun, injectedFault?: LiveFault): LiveDiagnosis {
  const failed = run.assertions.filter(item => !item.passed);
  const events = run.evidence.events ?? [];
  const observedFacts = failed.map(item => `${item.code}: expected ${item.expected}; observed ${item.actual}.`);
  if (failed.some(item => item.code === 'MONITOR_INTERRUPTED' || (item.code === 'REQUEST_COMPLETED' && /Interrupted by backend restart/i.test(item.actual)))) {
    const confirmed = events.some(event => event.kind === 'log' && event.data?.monitorRestarted === true);
    return { source:'rules',category:'monitor_interrupted',summary:'The monitoring backend restarted before this check completed; this result does not establish a website outage.',observedFacts,possibleCauses:confirmed?[]:['The monitoring process stopped or restarted before it could finish.'],confirmedCause:confirmed?'The monitoring backend restarted before the check completed.':null,solutions:['Start a fresh GET check to establish the current website state.','Inspect monitoring process and hosting restart logs; use the independent observer to inspect website availability during the interruption.'],evidenceIds:events.map(event=>event.id) };
  }
  if (run.httpStatus !== null) observedFacts.unshift(`A real website request returned HTTP ${run.httpStatus} with ${run.evidence.responseBytes} response bytes.`);
  else observedFacts.unshift(`The website request did not return a complete response: ${run.error ?? 'request failure'}.`);
  const faultObserved = (fault: LiveFault, endpoint?: string, status?: number) => events.some(event => event.data?.observed === true && event.data?.fault === fault && (!endpoint || event.data?.endpoint === endpoint) && (!status || event.data?.httpStatus === status));
  const hasFailed = (code: string) => failed.some(item => item.code === code);
  const correspondingFailure: Partial<Record<LiveFault, boolean>> = {
    http_500: run.httpStatus === 500, http_503: run.httpStatus === 503, not_found: run.httpStatus === 404,
    missing_content: run.httpStatus === 200 && hasFailed('EXPECTED_CONTENT'), empty_body: run.httpStatus === 200 && run.evidence.responseBytes === 0,
    timeout: hasFailed('REQUEST_COMPLETED') && /timed out after 12 seconds/i.test(run.error ?? ''),
    javascript_error: failed.some(item => item.code === 'BROWSER_JAVASCRIPT' && /Controlled JavaScript initialization error/i.test(item.actual)),
    button_broken: hasFailed('BROWSER_LOGIN'),
    login_401: hasFailed('BROWSER_LOGIN') && faultObserved('login_401', 'login', 401),
    database_unavailable: hasFailed('BROWSER_CART') && faultObserved('database_unavailable', 'catalog', 503),
    payment_unavailable: hasFailed('BROWSER_CONFIRMATION') && faultObserved('payment_unavailable', 'confirmation', 503),
  };
  const confirmed = injectedFault && injectedFault !== 'healthy' && correspondingFailure[injectedFault] && faultObserved(injectedFault);
  if (confirmed) {
    const explanation = explanations[injectedFault];
    return { source: 'rules', category: explanation.category, summary: `Controlled website failure detected: ${explanation.category.replaceAll('_', ' ')}.`, observedFacts, possibleCauses: [], confirmedCause: explanation.cause, solutions: explanation.solutions, evidenceIds: events.map(event => event.id) };
  }
  let category = 'assertion_failure'; let possibleCauses = ['The returned response did not meet the configured website requirement.']; let solutions = ['Inspect the failed assertion and correlated application logs, correct the response or requirement, then verify the same target again.'];
  if (failed.some(item => item.code === 'REQUEST_COMPLETED')) {
    const error = run.error ?? ''; const timeout = /timed?\s*out|timeout|abort/i.test(error);
    category = timeout ? 'timeout' : /ENOTFOUND|EAI_AGAIN|DNS|name resolution/i.test(error) ? 'dns_error' : /TLS|SSL|CERT_|certificate/i.test(error) ? 'tls_error' : /ECONNREFUSED|ECONNRESET|socket hang up/i.test(error) ? 'connection_error' : 'network_error';
    possibleCauses = timeout ? ['Slow application or dependency responses.', 'DNS, connection or network delays.'] : category === 'dns_error' ? ['The hostname could not be resolved or its DNS lookup failed.'] : category === 'tls_error' ? ['The HTTPS certificate or TLS handshake was rejected.'] : ['An unavailable origin or interrupted network connection.'];
    solutions = ['Inspect DNS, TLS, reachability and origin logs for this request window.', 'Restore the failing network or application dependency and verify a completed response within 12 seconds.'];
  } else if (run.httpStatus !== null && run.httpStatus >= 500) {
    category = run.httpStatus === 503 ? 'service_unavailable' : 'server_error'; possibleCauses = ['An application exception or failed dependency.', 'Maintenance, capacity exhaustion or an unhealthy upstream service.'];
    solutions = ['Correlate the measured HTTP status with application, proxy and dependency logs.', 'Correct the evidenced failure, restore service readiness and run a fresh verification.'];
  } else if (run.httpStatus === 404) {
    category = 'missing_route'; possibleCauses = ['A wrong or removed URL.', 'Deployment or reverse proxy routing mismatch.']; solutions = ['Check the configured URL and deployed route, restore the route or correct its approved configuration, then verify.'];
  } else if ([401,403].includes(run.httpStatus ?? 0)) {
    category = 'authentication'; possibleCauses = ['Authentication or authorization rejected the request.', 'Protection rules block unauthenticated monitors.']; solutions = ['Inspect auth and access-rule logs; use a dedicated permitted monitoring endpoint without adding credentials to URLs.'];
  } else if (run.evidence.responseBytes === 0) {
    category = 'empty_response'; possibleCauses = ['An empty origin response or early response termination.', 'A proxy or template rendering error.']; solutions = ['Inspect response handling, rendering and proxy logs; restore the required response body and verify.'];
  } else if (failed.some(item => ['BROWSER_JOURNEY_AVAILABLE','BROWSER_RUNNER_AVAILABLE'].includes(item.code))) {
    category = 'browser_monitor_unavailable'; possibleCauses = ['The independent browser monitor is unavailable or not configured.']; solutions = ['Restore the independent browser monitor and repeat the actual user journey; HTTP alone cannot verify button, login or checkout behavior.'];
  } else if (failed.some(item => /JAVASCRIPT|PAGE_ERROR/.test(item.code))) {
    category = 'javascript_error'; possibleCauses = ['An uncaught JavaScript exception disrupted the user journey.']; solutions = ['Use the captured browser page errors and source maps to identify the failing script, fix it and repeat the journey.'];
  } else if (failed.some(item => item.code === 'EXPECTED_CONTENT')) {
    category = 'missing_content'; possibleCauses = ['Rendering or data-loading failure.', 'The site content or redirect destination changed.']; solutions = ['Inspect rendering and data requests, restore the required content or update the approved requirement, then verify.'];
  } else {
    category = 'broken_interaction'; possibleCauses = ['A browser interaction or synthetic user flow failed.', 'A client-side exception or API dependency rejected the action.']; solutions = ['Inspect captured browser errors, failed responses and resulting UI state; repair the affected action and repeat the complete journey.'];
  }
  return { source: 'rules', category, summary: `${category.replaceAll('_', ' ')} detected; the underlying cause needs correlated server or browser evidence.`, observedFacts, possibleCauses, confirmedCause: null, solutions, evidenceIds: events.map(event => event.id) };
}
