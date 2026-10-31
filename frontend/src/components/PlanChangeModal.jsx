import React, { useState, useEffect } from "react";
import api from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { 
  Check, AlertTriangle, Loader2, X, Shield, ArrowRight, Trash2, Box 
} from "lucide-react";

const TIERS = [
  { id: 'FREE', label: 'Free', price: '$0/mo', description: 'For personal hobby projects', features: ['1 Project', '1 Concurrent Build'] },
  { id: 'HOBBY', label: 'Hobby', price: '$10/mo', description: 'For serious side projects', features: ['2 Projects', '1 Concurrent Build'] },
  { id: 'PRO', label: 'Pro', price: '$29/mo', description: 'For professional developers', features: ['Unlimited Projects', '3 Concurrent Builds', 'Auto-Deploy Webhooks', 'Live Logs'] },
  { id: 'ENTERPRISE', label: 'Enterprise', price: 'Custom', description: 'For large teams', features: ['Unlimited Projects', '10 Concurrent Builds', 'Priority Support'] }
];

export default function PlanChangeModal({ isOpen, onClose, currentTier, onPlanChanged, showToast }) {
  const { login, tier: authTier } = useAuth();
  const effectiveTier = currentTier || authTier || 'FREE';

  const [selectedTier, setSelectedTier] = useState(effectiveTier);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('SELECT'); // SELECT | CONFIRM
  const [cleanupData, setCleanupData] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedTier(effectiveTier);
      setStep('SELECT');
      setCleanupData(null);
    }
  }, [isOpen, effectiveTier]);

  const handleChangePlan = async (confirmCleanup = false) => {
    if (!selectedTier || selectedTier === effectiveTier) return;
    
    setLoading(true);

    try {
      const res = await api.post("/api/account/change-tier", {
        newTier: selectedTier,
        confirmCleanup
      });

      const { needsCleanup, changed, willDeleteProjects, willDeletePreviews, token: newToken } = res.data;

      if (needsCleanup) {
        setCleanupData({ projects: willDeleteProjects, previews: willDeletePreviews });
        setStep('CONFIRM');
        return;
      }

      if (changed) {
        if (newToken) {
          login(newToken);
        }
        onPlanChanged?.(); // Refresh dashboard
        showToast?.('Plan changed successfully', 'success');
        onClose();
      }

    } catch (err) {
      console.error(err);
      showToast?.(err.response?.data?.message || err.response?.data?.error || 'Something went wrong', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* HEADER */}
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
          <h2 className="text-lg font-bold text-gray-900">
            {step === 'SELECT' ? 'Change Subscription Plan' : 'Confirm Downgrade'}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition-colors text-gray-500">
            <X size={18} />
          </button>
        </div>

        {/* CONTENT */}
        <div className="p-6 overflow-y-auto custom-scrollbar">
          
          {step === 'SELECT' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {TIERS.map((tier) => {
                  const isCurrent = effectiveTier === tier.id;
                  const isSelected = selectedTier === tier.id;
                  
                  return (
                    <div 
                      key={tier.id}
                      onClick={() => !isCurrent && setSelectedTier(tier.id)}
                      className={`relative p-4 rounded-xl border-2 transition-all cursor-pointer flex flex-col h-full
                        ${isCurrent ? 'border-gray-200 bg-gray-50 opacity-60 cursor-default' : 
                          isSelected ? 'border-black bg-gray-50 shadow-md' : 'border-gray-100 hover:border-gray-300 hover:shadow-sm'}
                      `}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className="font-bold text-sm tracking-wide text-gray-900">{tier.label}</span>
                        {isCurrent && <span className="bg-gray-200 text-gray-600 text-[10px] font-bold px-2 py-0.5 rounded-full">CURRENT</span>}
                        {isSelected && !isCurrent && <CheckCircleIcon />}
                      </div>
                      <div className="text-2xl font-bold text-gray-900 mb-1">{tier.price}</div>
                      <p className="text-xs text-gray-500 mb-4">{tier.description}</p>
                      <ul className="space-y-2 mt-auto">
                        {tier.features.map((feat, i) => (
                          <li key={i} className="flex items-center gap-2 text-xs text-gray-600">
                            <Check size={12} className="text-green-600 shrink-0" /> {feat}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            // CONFIRMATION STEP
            <div className="space-y-6">
              <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex gap-4">
                <div className="p-2 bg-red-100 rounded-full h-fit text-red-600">
                  <AlertTriangle size={24} />
                </div>
                <div>
                  <h3 className="text-red-900 font-bold text-sm">Downgrade Confirmation</h3>
                  <p className="text-red-700 text-sm mt-1">
                    You are downgrading from <span className="font-bold">{effectiveTier}</span> to <span className="font-bold">{selectedTier}</span>. 
                    This exceeds your new plan limits. The following resources will be <span className="underline font-bold">permanently deleted</span>:
                  </p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-2 bg-gray-100 border-b border-gray-200 text-xs font-bold text-gray-500 flex justify-between">
                  <span>ITEM TO DELETE</span>
                  <span>TYPE</span>
                </div>
                <div className="max-h-[200px] overflow-y-auto divide-y divide-gray-100 p-2">
                  {cleanupData?.projects?.map(p => (
                    <div key={p.id} className="flex items-center justify-between p-2">
                      <div className="flex items-center gap-3">
                        <Box size={16} className="text-gray-400" />
                        <span className="text-sm font-medium text-gray-700">{p.repoOwner}/{p.repoName}</span>
                      </div>
                      <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">PROJECT</span>
                    </div>
                  ))}
                  {cleanupData?.previews?.map(p => (
                    <div key={p.id} className="flex items-center justify-between p-2">
                      <div className="flex items-center gap-3">
                        <Box size={16} className="text-gray-400" />
                        <span className="text-sm text-gray-600">Preview PR #{p.prNumber}</span>
                      </div>
                      <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-bold">PREVIEW</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
          {step === 'SELECT' ? (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-black transition-colors">Cancel</button>
              <button 
                onClick={() => handleChangePlan(false)}
                disabled={loading || selectedTier === effectiveTier}
                className="bg-black text-white px-6 py-2 rounded-full text-sm font-semibold hover:bg-gray-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Shield size={16} />}
                Update Plan
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setStep('SELECT')} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-black">Back</button>
              <button 
                onClick={() => handleChangePlan(true)} // Confirm cleanup
                disabled={loading}
                className="bg-red-600 text-white px-6 py-2 rounded-full text-sm font-semibold hover:bg-red-700 transition-all shadow-md active:scale-95 flex items-center gap-2"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                Confirm Downgrade
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckCircleIcon() {
  return (
    <div className="bg-black text-white rounded-full p-0.5">
      <Check size={10} />
    </div>
  );
}
