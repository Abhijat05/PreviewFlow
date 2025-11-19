import { useEffect, useState } from "react";
import axios from "axios";

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const token = localStorage.getItem("token");

  useEffect(() => {
    axios.get("http://localhost:4000/api/projects", {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => setProjects(res.data))
    .catch(console.error);
  }, []);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Your Projects</h1>

      {projects.map(project => (
        <div key={project.id} className="border rounded p-4 mb-6 shadow">
          <h2 className="text-xl font-semibold">
            {project.repoOwner}/{project.repoName}
          </h2>

          <div className="mt-3">
            <h3 className="font-medium mb-2">Previews</h3>

            {project.previews.length === 0 && (
              <p className="text-gray-500">No previews yet.</p>
            )}

            {project.previews.map(pre => (
              <div
                key={pre.id}
                className="flex items-center justify-between bg-gray-100 p-3 rounded mb-2"
              >
                <div>
                  <p className="font-medium">PR #{pre.prNumber}</p>
                  <p className="text-sm text-gray-600">Status: {pre.status}</p>
                </div>

                <div className="flex gap-2">
                  {pre.url && (
                    <a
                      href={pre.url}
                      target="_blank"
                      className="px-3 py-1 bg-green-600 text-white rounded"
                    >
                      Open
                    </a>
                  )}

                  {pre.status === "error" && (
                    <button className="px-3 py-1 bg-yellow-600 text-white rounded">
                      Rebuild
                    </button>
                  )}

                  {(pre.status === "live" || pre.status === "building") && (
                    <button className="px-3 py-1 bg-red-600 text-white rounded">
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
