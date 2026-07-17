#!/bin/bash

# Script to help you push to GitHub for Render
# Instructions:
# 1. Create a NEW repository on GitHub (keep it private if you want).
# 2. Copy the SSH or HTTPS URL of that repo.
# 3. Run this script: ./deploy_to_github.sh <YOUR_REPO_URL>

REPO_URL=$1

if [ -z "$REPO_URL" ]; then
    echo "Error: Por favor, proporciona la URL de tu repositorio de GitHub."
    echo "Uso: ./deploy_to_github.sh https://github.com/usuario/mi-repositorio.git"
    exit 1
fi

echo "--- Iniciando preparación para GitHub ---"

# Initialize git if not already present
if [ ! -d ".git" ]; then
    git init
fi

# Add all files (including the mock database fixes)
git add .

# Initial commit
git commit -m "Fix: Render-ready with intelligent DB selector"

# Set branch to main
git branch -M main

# Add remote
git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"

# Push
echo "--- Subiendo código a GitHub ---"
git push -u origin main

echo "--- ¡Listo! ---"
echo "Ahora solo ve a Render (dashboard.render.com), crea un 'New Web Service' y selecciona este repositorio."
