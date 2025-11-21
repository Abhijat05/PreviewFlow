import React, { useEffect, useState } from "react";
import axios from "axios";
import io from "socket.io-client";
import { useNavigate } from "react-router-dom";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent
} from "@/components/ui/card";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import {
  ExternalLink,
  RefreshCw,
  Trash,
  GitPullRequest,
  Loader2,
  AlertTriangle
} from "lucide-react";

// Socket.io connection
const socket = io("http://localhost:4000", { transports: ["websocket"] });

/**
 * Utility: calculate build time
 */
function getBuildTime(pre) {
  if (!pre.buildStartedAt || !pre.buildCompletedAt) return null;

  const s = new Date(pre.buildStartedAt);
  const e = new Date(pre.buildCompletedAt);
  const sec = ((e - s) / 1000).toFixed(1);

  return sec + "s";
}

/**
 * Badge colors based on status
 */
function badgeColor(status) {
  switch (status) {
    case "live":
      return "bg-green-600 text-white";
    case "building":
      return "bg-yellow-400 text-black";
    case "error":
      return "bg-red-600 text-white";
    case "deleted":
      return "bg-gray-400";
    default:
      return "bg-gray-300";
  }
}

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [processingPreview, setProcessingPreview] = useState(null);

  const token = localStorage.getItem("token");
  const navigate = useNavigate();

  // --------------------------------------------
  // Load projects once on mount
  // --------------------------------------------
  useEffect(() => {
    if (!token) return navigate("/");

    axios
      .get("http://localhost:4000/api/projects", {
        headers: { Authorization: `Bearer ${token}` }
      })
      .then((res) => setProjects(res.data))
      .catch(() => navigate("/"));

    // real-time updates from backend
    socket.on("preview-status-update", (update) => {
      setProjects((old) =>
        old.map((project) => {
          if (project.id !== update.projectId) return project;

          return {
            ...project,
            previews: project.previews.map((pre) =>
              pre.prNumber === update.prNumber
                ? { ...pre, ...update }
                : pre
            )
          };
        })
      );
    });

    return () => socket.off("preview-status-update");
  }, []);

  // --------------------------------------------
  // Actions
  // --------------------------------------------
  const rebuild = async (pre) => {
    setProcessingPreview(pre.id);
    await axios.post(
      `http://localhost:4000/api/preview/${pre.id}/rebuild`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    setProcessingPreview(null);
  };

  const del = async (pre) => {
    if (!confirm("Delete this preview?")) return;

    setProcessingPreview(pre.id);
    await axios.post(
      `http://localhost:4000/api/preview/${pre.id}/delete`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    setProcessingPreview(null);
  };

  // --------------------------------------------
  // UI
  // --------------------------------------------
  return (
    <div className="p-8 max-w-6xl mx-auto">
      <h1 className="text-4xl font-semibold mb-8">Dashboard</h1>

      {projects.map((project) => (
        <Card key={project.id} className="mb-6 shadow">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitPullRequest className="w-5 h-5 text-blue-600" />
              {project.repoOwner}/{project.repoName}
            </CardTitle>
            <CardDescription>Pull Request Previews</CardDescription>
          </CardHeader>

          <CardContent>
            {project.previews.length === 0 ? (
              <p className="text-gray-500">No previews yet.</p>
            ) : (
              project.previews.map((pre) => (
                <div
                  key={pre.id}
                  className="border rounded-lg p-4 mb-3 flex justify-between items-center"
                >
                  <div className="flex-col gap-1">
                    <p className="font-medium text-lg">PR #{pre.prNumber}</p>

                    <Badge className={badgeColor(pre.status)}>
                      {pre.status}
                    </Badge>

                    {pre.status === "error" && (
                      <div className="flex items-center gap-2 text-red-600 mt-1 text-sm">
                        <AlertTriangle className="w-4 h-4" />
                        <span>Build Failed</span>
                      </div>
                    )}

                    {getBuildTime(pre) && (
                      <p className="text-sm text-gray-500">
                        Build time: <strong>{getBuildTime(pre)}</strong>
                      </p>
                    )}

                    {pre.url && pre.status === "live" && (
                      <p
                        className="text-blue-600 underline text-sm cursor-pointer"
                        onClick={() => window.open(pre.url, "_blank")}
                      >
                        {pre.url}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-2">
                    {/* Logs Button */}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => navigate(`/logs/${pre.id}`)}
                    >
                      <ExternalLink className="w-4 h-4 mr-1" /> Logs
                    </Button>

                    {/* Rebuild Button */}
                    <Button
                      size="sm"
                      onClick={() => rebuild(pre)}
                      disabled={processingPreview === pre.id}
                    >
                      {processingPreview === pre.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      Rebuild
                    </Button>

                    {/* Delete Button */}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={processingPreview === pre.id}
                      onClick={() => del(pre)}
                    >
                      <Trash className="w-4 h-4 mr-1" /> Delete
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
