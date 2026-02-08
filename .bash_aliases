# Firebase
alias fd='firebase deploy'
alias fdh='firebase deploy --only hosting'
alias fdf='firebase deploy --only functions'

# Git
alias gs='git status'

# GCA: commit current changes → pull --rebase → auto-commit → push
alias gca='
  echo "📦 Pre-rebase commit (if needed)...";
  git add . &&
  git commit -m "Temp pre-rebase commit" ||
  echo "No files to commit";

  echo "🔄 Pulling with rebase...";
  git pull --rebase;

  echo "📝 Auto-commit (if needed)...";
  git add . &&
  git commit -m "Auto-commit on $(date +'%A, %b %d @ %H:%M')" ||
  echo "No new changes after rebase";

  echo "🚀 Pushing...";
  git push
'

# Fix hidden unicode NBSP spaces in a file
alias fix='read -p "Enter file path: " file && sed -i "s/\xc2\xa0/ /g" "$file"'
