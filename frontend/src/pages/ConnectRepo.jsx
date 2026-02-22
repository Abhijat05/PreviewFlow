import React, { useEffect, useState } from "react";
import axios from "axios";
import { Github, Search, Loader2, ArrowRight, Layout, ArrowLeft, Lock, Zap, CheckCircle2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

const TIER_LIMITS = {
  FREE: { projects: 1, allowWebhook: false },
  HOBBY: { projects: 2, allowWebhook: false },
  PRO: { projects: Infinity, allowWebhook: true },
  ENTERPRISE: { projects: Infinity, allowWebhook: true }
};

const getUserTier = (token) => {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return (payload.tier || 'FREE').toUpperCase();
  } catch { return 'FREE'; }
};

export default function ConnectRepo() {
  const [repos, setRepos] = useState([]);
  const [existingProjects, setExistingProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [connectingId, setConnectingId] = useState(null);
  const [userTier, setUserTier] = useState("FREE");

  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) return;

    // 1. Initial Tier from Token
    setUserTier(getUserTier(token));

    const controller = new AbortController();

    // 2. Fetch Repos & Projects
    Promise.all([
      axios.get("http://localhost:4000/api/repos", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }),
      axios.get("http://localhost:4000/api/projects", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
    ]).then(([reposRes, projectsRes]) => {
      setRepos(reposRes.data);
      setExistingProjects(projectsRes.data);
      setLoading(false);
    }).catch(err => {
      if (!axios.isCancel(err)) {
        console.error(err);
        setLoading(false);
      }
    });

    // 3. Fetch User Profile to Sync Tier (Fresh from DB)
    axios.get("http://localhost:4000/api/user/me", {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    }).then(res => {
      if (res.data.tier) setUserTier(res.data.tier.toUpperCase());
    }).catch(err => { 
      if (!axios.isCancel(err)) console.error("Failed to sync tier", err); 
    });

    return () => controller.abort();
  }, []);

  const handleConnect = async (r) => {
    const token = localStorage.getItem("token");
    const limits = TIER_LIMITS[userTier];

    if (existingProjects.length >= limits.projects) {
      alert(`⚠️ Project Limit Reached!\n\nThe ${userTier} tier allows only ${limits.projects} connected projects.`);
      return;
    }

    setConnectingId(r.fullName);

    try {
      const res = await axios.post("http://localhost:4000/api/connect-repo", {
        repoOwner: r.owner,
        repoName: r.name
      }, { headers: { Authorization: `Bearer ${token}` } });

      const projectId = res.data.project.id;

      if (limits.allowWebhook) {
        await axios.post("http://localhost:4000/api/create-webhook", { projectId }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      alert(`✅ ${r.name} Connected!`);
      navigate("/");

    } catch (err) {
      console.error(err);
      alert("❌ Connection Failed.");
    } finally {
      setConnectingId(null);
    }
  };

  const filteredRepos = repos.filter(r => r.fullName.toLowerCase().includes(searchQuery.toLowerCase()));
  const limits = TIER_LIMITS[userTier] || TIER_LIMITS.FREE;
  const isLimitReached = existingProjects.length >= limits.projects;

  return (
    <div className="h-screen bg-[#fafafa] text-gray-900 font-sans relative overflow-hidden flex flex-col">
      <div className="absolute inset-0 z-0 opacity-[0.4] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

      <div className="relative z-10 w-full max-w-3xl mx-auto h-full flex flex-col p-6 md:p-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        <div className="shrink-0">
            <button onClick={() => navigate('/dashboard')} className="group flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-black transition-colors mb-8 pl-1 w-fit">
              <div className="p-1 bg-white border border-gray-200 rounded-lg group-hover:border-gray-300 shadow-sm transition-all"><ArrowLeft size={16} /></div>
              Back to Dashboard
            </button>

            <div className="mb-8 text-center">
              <div className="w-12 h-12 bg-white border border-gray-200 rounded-xl shadow-sm flex items-center justify-center mx-auto mb-4"><Layout className="w-6 h-6 text-black" /></div>
              <h1 className="text-3xl font-bold tracking-tight text-gray-900 mb-2">Import a Repository</h1>
              
              <div className="flex items-center justify-center gap-2 mt-3">
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase border bg-gray-100 text-gray-600 border-gray-200`}>
                  {userTier} PLAN
                </span>
                <span className={`text-sm ${isLimitReached ? 'text-red-500 font-semibold' : 'text-gray-500'}`}>
                  {existingProjects.length} / {limits.projects === Infinity ? '∞' : limits.projects} Projects
                </span>
              </div>
            </div>

            {isLimitReached && (
              <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between shadow-sm animate-in slide-in-from-top-2">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-amber-100 rounded-full text-amber-600"><Lock size={16} /></div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Project Limit Reached</p>
                    <p className="text-xs text-gray-600">Upgrade to PRO to connect more repositories.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="relative mb-6">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Search className="h-4 w-4 text-gray-400" /></div>
              <input type="text" className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl leading-5 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-gray-400 sm:text-sm shadow-sm transition-all"
                placeholder="Search repositories..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            </div>
        </div>

        <div className="flex-1 min-h-0 bg-white border border-gray-200 rounded-2xl shadow-sm flex flex-col overflow-hidden mb-6">
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400"><Loader2 className="w-8 h-8 animate-spin mb-3" /><span className="text-sm font-medium">Fetching repositories...</span></div>
          ) : filteredRepos.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-500 p-12 text-center"><p>No repositories found matching "{searchQuery}"</p></div>
          ) : (
            <div className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-gray-100">
              {filteredRepos.map((r) => {
                const isConnecting = connectingId === r.fullName;
                const isAlreadyConnected = existingProjects.some(p => p.repoName === r.name && p.repoOwner === r.owner);
                const isDisabled = isConnecting || (isLimitReached && !isAlreadyConnected);

                return (
                  <div key={r.fullName} className={`group p-4 flex items-center justify-between hover:bg-gray-50 transition-all duration-200 ${isDisabled && !isAlreadyConnected ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <div className="flex items-center gap-4">
                      <div className="p-2 bg-gray-100 rounded-lg border border-transparent group-hover:border-gray-200"><Github className="w-5 h-5 text-gray-700" /></div>
                      <div className="flex flex-col">
                        <span className="font-mono text-sm font-semibold text-gray-900">{r.name}</span>
                        <span className="text-xs text-gray-500 mt-0.5">{r.fullName}</span>
                      </div>
                    </div>

                    <button
                      onClick={() => !isDisabled && !isAlreadyConnected && handleConnect(r)}
                      disabled={isDisabled || isAlreadyConnected}
                      className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-all duration-200 
                        ${isAlreadyConnected ? 'bg-green-100 text-green-700 border border-green-200' :
                          isDisabled ? 'bg-gray-100 text-gray-400 border border-gray-200' : 
                          'bg-black text-white group-hover:bg-gray-800 group-hover:shadow-md'}
                      `}
                    >
                      {isConnecting ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Importing...</> : 
                       isAlreadyConnected ? <><CheckCircle2 className="w-3.5 h-3.5" />Connected</> : 
                       isLimitReached ? <><Lock className="w-3.5 h-3.5" />Limit</> : 
                       <><ArrowRight className="w-3.5 h-3.5 opacity-60" />Import</>}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        
        {!limits.allowWebhook && (
          <div className="shrink-0 text-center pb-2 flex items-center justify-center gap-2 text-xs text-amber-600">
             <Zap size={12} className="fill-amber-600" />
             <span>Auto-deployments are disabled on {userTier} tier.</span>
          </div>
        )}
      </div>
      <style>{`.custom-scrollbar::-webkit-scrollbar { width: 6px; } .custom-scrollbar::-webkit-scrollbar-track { background: transparent; } .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #e5e7eb; border-radius: 20px; } .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #d1d5db; }`}</style>
    </div>
  );
}