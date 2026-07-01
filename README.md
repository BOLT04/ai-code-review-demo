# AI Code Review Demo for Talks

This is a simple demo showcasing how we can use evals and multi-agent AI systems to do code review. The main tools on this repo are GitHub Copilot and Claude Code, but the talk has some generic tips and practical workflows that are tool-agnostic.
It's intended to be used as the demo of a specific talk about AI code review.

## Demo app instructions
Read the instructions in `src/README.md`.

## Session Abstracts

### Practical workflows for AI code review

AI adoption is on the rise throughout our SDLC, and so is the number of merged PRs. Speed over quality is not always a good trade-off, so having code reviews in a software team is essential for many reasons. In this talk, we'll dive deep into adopting AI for code review, using GitHub Copilot and Claude Code. I'll share my team's pragmatic approach to measuring the quality of AI tools, like signal-to-noise ratio and other metrics.

Plus, I'll share the prompts and workflows that have been effective for me and my team, what works, and the challenges we overcame adopting AI for code reviews. If you are thinking about adopting AI for code reviews, this talk is for you!

### Multi-agent AI systems that produce high-quality software

Software quality is crucial for many teams. It defines the trust and expectation customers have in your product, but is often less important than pure speed in some organizations. So using AI to speed up code generation only leads to hundreds of PRs senior engineers must review. This is no longer enough to ensure high-quality software.

In this session, we'll dive deep into multi-agent code review agents that can catch bugs and ensure the quality standards of your team. We'll augment our engineers with agents that help them in the development and review phase of our SDLC.
Key takeaways:
- Software quality is often less important than pure speed. With multi-agent AI systems this could be a smaller trade-off than it is today
- Attendees will learn how to build a multi-agent system with the Copilot SDK. They will learn multi-agent design patterns like the debate pattern or group chat pattern. They will also learn practical ways of ensuring software quality while adopting AI tools like GitHub Copilot

### Leveraging Copilot for code review with custom agents

Nowadays, we are creating more PRs per day and senior engineers are tasked with code review. Ensuring quality software gets merged is crucial to keeping our production software reliable.

GitHub Copilot's built-in code review already handles a lot of the noise, like style issues, missing tests, and common bugs. In this session, we'll do a live walkthrough of what it catches out of the box, and then build a custom code review agent using the Copilot SDK, showcasing how you can make a high-quality code review agent.

### Slides
The slides for the talk are in [slides/genai-meetup-2026-practical-workflows-ai-code-review.pdf](slides/genai-meetup-2026-practical-workflows-ai-code-review.pdf). This was for the [GenAI Lisbon meetup 2026](https://www.meetup.com/lisbon-genai-community/events/315381061/).

### Duration
25min - 45min

### Target audience
Developers, Architects

## Cool AI code review resources
If you're interested in learning more about AI code review, here are a few links:
- [Unbiased OSS Benchmark For Code Review Agents](https://codereview.withmartian.com/)
- [Agentic Code Review](https://addyosmani.com/blog/agentic-code-review/)
- [Why AI will never replace human code review](https://graphite.com/blog/ai-wont-replace-human-code-review)
- [Cloudflare Orchestrating AI Code Review at scale](https://blog.cloudflare.com/ai-code-review/)
- Blog post I wrote about [AI code review](https://dev.to/bolt04/lessons-learned-improving-code-reviews-with-ai-1c00)
