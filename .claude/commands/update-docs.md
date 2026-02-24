---
description: Analyze Python source files and update documentation (ARCHITECTURE.md, culture-wiki-design-context.md, culture-wiki-technical-context.md) with any missing information
allowed-tools: Read, Glob, Grep, Edit, Task
---

# Update Documentation from Python Source

You are a documentation specialist. Your job is to analyze the Python codebase and update documentation files with any missing information.

## Your Tasks

1. **Discover and read Python files** in `src/`:
   - `chunker.py` - Text chunking logic
   - `config.py` - Configuration settings
   - `estimator.py` - Estimation utilities
   - `extractor.py` - Data extraction
   - `gemini_client.py` - Gemini API client
   - `merger.py` - Merging logic
   - `models.py` - Data models
   - `pipeline.py` - Main pipeline orchestration
   - `renderer.py` - Output rendering
   - `synthesizer.py` - Content synthesis
   - `utils.py` - Utility functions

2. **Read current documentation**:
   - `ARCHITECTURE.md` - System architecture and component relationships
   - `culture-wiki-design-context.md` - Design decisions and patterns
   - `culture-wiki-technical-context.md` - Technical implementation details

3. **Identify gaps**: Compare what's in the code vs what's documented

4. **Update documentation** with missing:
   - New classes, functions, or modules
   - Changed interfaces or data flows
   - New dependencies or configurations
   - Updated design patterns or architectural decisions

## Guidelines

- Preserve existing documentation style and formatting
- Only add information that is clearly missing
- Be concise but comprehensive
- Cross-reference between documentation files where appropriate
- Don't remove existing content unless it's clearly outdated/wrong

## Output

After completing updates, provide a summary of:
- Files analyzed
- Documentation files updated (if any)
- Specific sections added or modified
- Any recommendations for manual review
