const crypto=require('crypto');
const GMAIL_SCOPE='https://www.googleapis.com/auth/gmail.readonly';
class GoogleOAuth {
 constructor({clientId,clientSecret,redirectUri,refreshToken,onRefreshToken,fetchImpl=fetch}={}){Object.assign(this,{clientId:clientId||'',clientSecret:clientSecret||'',redirectUri:redirectUri||'',refreshToken:refreshToken||'',onRefreshToken,fetchImpl});this.states=new Map();}
 isConfigured(){return Boolean(this.clientId&&this.clientSecret&&this.redirectUri);}
 isConnected(){return Boolean(this.refreshToken);}
 createAuthorizationUrl(){if(!this.isConfigured())throw new Error('Google OAuth is not configured.');const state=crypto.randomBytes(24).toString('base64url');this.states.set(state,Date.now()+10*60*1000);const q=new URLSearchParams({client_id:this.clientId,redirect_uri:this.redirectUri,response_type:'code',scope:GMAIL_SCOPE,access_type:'offline',include_granted_scopes:'true',prompt:'consent',state});return 'https://accounts.google.com/o/oauth2/v2/auth?'+q.toString();}
 consumeState(state){const exp=this.states.get(String(state||''));this.states.delete(String(state||''));return Boolean(exp&&exp>Date.now());}
 async tokenRequest(params){const r=await this.fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});const data=await r.json();if(!r.ok)throw new Error(data.error_description||data.error||'Google OAuth token request failed.');return data;}
 async exchangeCode(code){const t=await this.tokenRequest({client_id:this.clientId,client_secret:this.clientSecret,code,grant_type:'authorization_code',redirect_uri:this.redirectUri});if(t.refresh_token){this.refreshToken=t.refresh_token;await this.onRefreshToken?.(t.refresh_token);}return t;}
 async accessToken(){if(!this.refreshToken)throw new Error('Work Gmail is not connected with Google OAuth.');const t=await this.tokenRequest({client_id:this.clientId,client_secret:this.clientSecret,refresh_token:this.refreshToken,grant_type:'refresh_token'});return t.access_token;}
}
function buildGoogleOAuthFromEnv(opts={}){return new GoogleOAuth({clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,clientSecret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,redirectUri:process.env.GOOGLE_OAUTH_REDIRECT_URI||((process.env.APP_URL||'https://personal-memory-bank.onrender.com')+'/api/google/oauth/callback'),refreshToken:process.env.GOOGLE_OAUTH_REFRESH_TOKEN,...opts});}
module.exports={GoogleOAuth,buildGoogleOAuthFromEnv,GMAIL_SCOPE};
