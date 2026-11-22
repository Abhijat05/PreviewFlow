// frontend/src/tests/ResourceMonitor.test.jsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceMonitor } from "../components/ResourceMonitor.jsx";

describe("8. ResourceMonitor Component Tests", () => {
  it("renders animated skeleton state when stats is null or undefined", () => {
    const { container } = render(<ResourceMonitor stats={null} />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders CPU percentage and RAM usage correctly for normal stats", () => {
    const stats = {
      cpu: 24.5,
      memory: 209715200 // ~200 MB
    };

    render(<ResourceMonitor stats={stats} />);

    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("24.5%")).toBeInTheDocument();
    expect(screen.getByText("RAM")).toBeInTheDocument();
    expect(screen.getByText("200 MB")).toBeInTheDocument();
  });

  it("applies red text and alert styles when CPU exceeds 70%", () => {
    const highCpuStats = {
      cpu: 85.0,
      memory: 104857600
    };

    render(<ResourceMonitor stats={highCpuStats} />);

    const cpuElement = screen.getByText("85.0%");
    expect(cpuElement).toHaveClass("text-red-500");
  });

  it("applies amber alert styles when memory exceeds 400 MB", () => {
    const highRamStats = {
      cpu: 10.0,
      memory: 450 * 1024 * 1024 // 450 MB
    };

    render(<ResourceMonitor stats={highRamStats} />);

    const ramElement = screen.getByText("450 MB");
    expect(ramElement).toHaveClass("text-amber-500");
  });

  it("triggers onClick handler when clicked", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    const stats = { cpu: 15.0, memory: 100 * 1024 * 1024 };

    render(
      <div onClick={handleClick}>
        <ResourceMonitor stats={stats} />
      </div>
    );

    await user.click(screen.getByText("CPU"));
    expect(handleClick).toHaveBeenCalled();
  });
});
