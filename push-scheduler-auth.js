const ISSUER='https://token.actions.githubusercontent.com';
const AUDIENCE='jarvis-reminders';
const REPOSITORY='coxdavid9/personal-memory-bank';
let remoteKeys;
function allowedClaims(payload) {
  return payload.repository===REPOSITORY && payload.ref==='refs/heads/main' &&
    payload.sub==='repo:'+REPOSITORY+':ref:refs/heads/main' &&
    payload.workflow_ref===REPOSITORY+'/.github/workflows/reminders.yml@refs/heads/main' &&
    ['schedule','workflow_dispatch'].includes(payload.event_name);
}
async function verifySchedulerToken(token) {
  if (typeof token!=='string' || token.length>16000) return false;
  try {
    const {createRemoteJWKSet}=await import('jose');
    remoteKeys ||= createRemoteJWKSet(new URL(ISSUER+'/.well-known/jwks'),{timeoutDuration:5000});
    return verifySignedSchedulerToken(token,remoteKeys);
  } catch {return false;}
}
function reportRejection(reason) {
  console.warn('Scheduler authentication rejected:',reason);
}
async function verifySignedSchedulerToken(token,keys) {
  try {
    const {jwtVerify}=await import('jose');
    const {payload}=await jwtVerify(token,keys,{issuer:ISSUER,audience:AUDIENCE,algorithms:['RS256'],maxTokenAge:'10m'});
    if (!allowedClaims(payload)) {reportRejection('workflow_claims');return false;}
    return true;
  } catch (err) {
    const codes=new Set(['ERR_JWT_EXPIRED','ERR_JWT_CLAIM_VALIDATION_FAILED','ERR_JWS_SIGNATURE_VERIFICATION_FAILED','ERR_JWKS_TIMEOUT','ERR_JWKS_NO_MATCHING_KEY','ERR_JOSE_ALG_NOT_ALLOWED','ERR_JWS_INVALID']);
    reportRejection(codes.has(err?.code)?err.code:'verification_error');
    return false;
  }
}
module.exports={verifySchedulerToken,allowedClaims,verifySignedSchedulerToken};
